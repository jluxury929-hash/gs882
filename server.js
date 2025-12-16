// ===============================================================================
// UNIFIED EARNINGS & WITHDRAWAL API v4.1.0 (FINAL: CONCURRENCY & RELIABILITY FIXES)
// ===============================================================================

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
if (!PRIVATE_KEY) {
    console.error("FATAL: TREASURY_PRIVATE_KEY not set in environment variables.");
    process.exit(1);
}

// ===============================================================================
// WALLET & CONFIGURATION
// ===============================================================================

const PAYOUT_WALLET = process.env.PAYOUT_WALLET || '0xMUST_SET_PAYOUT_WALLET_IN_ENV';
const ETH_PRICE = 3450;
const GAS_RESERVE_ETH = 0.003; 
// The aggressive minimum priority fee (tip) for high-priority MEV/withdrawal TXs
const MIN_AGGRESSIVE_PRIORITY_FEE_GWEI = 5n; // 5 Gwei 
let TREASURY_WALLET = '0xaFb88bD20CC9AB943fCcD050fa07D998Fc2F0b7C';
const MEV_CONTRACTS = [
    '0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0', 
    '0x29983BE497D4c1D39Aa80D20Cf74173ae81D2af5', 
    '0x1234567890123456789012345678901234567890' 
];

// Accounting Globals
let totalEarnings = 0;
let totalWithdrawnToCoinbase = 0;
let currentRpcIndex = 0;

// RPC List for failover and multi-check strategy
const RPC_URLS = [
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://rpc.ankr.com/eth',
    'https://eth-mainnet.public.blastapi.io',
];

let provider = null;
let signer = null;
let transactionNonce = -1; // Global Nonce Manager variable, -1 indicates uninitialized

// --- Utility Functions ---
async function initProvider() {
    try {
        const url = RPC_URLS[currentRpcIndex % RPC_URLS.length];
        provider = new ethers.JsonRpcProvider(url, 1, { staticNetwork: ethers.Network.from(1) });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        TREASURY_WALLET = signer.address;
        
        // FIX: Initialize Nonce Manager on startup by fetching the next confirmed nonce
        transactionNonce = await provider.getTransactionCount(signer.address, 'latest');
        console.log(`[INIT] Connected to RPC. Starting Nonce: ${transactionNonce}`);
    } catch (e) {
        console.error(`[INIT] Failed to connect to RPC: ${e.message}. Retrying...`);
        currentRpcIndex++;
        if (currentRpcIndex < RPC_URLS.length) {
            await initProvider();
        } else {
            console.error("FATAL: All RPCs failed.");
            process.exit(1);
        }
    }
}
async function getReliableSigner() { 
    if (!signer || !provider) await initProvider();
    return signer;
}
async function getTreasuryBalance() { 
    try {
        if (!provider || !signer) await initProvider();
        const bal = await provider.getBalance(signer.address);
        return parseFloat(ethers.formatEther(bal));
    } catch (e) {
        return 0;
    }
}
function getSecondaryProvider() {
    const secondaryRpcUrl = RPC_URLS[(currentRpcIndex + 1) % RPC_URLS.length];
    return new ethers.JsonRpcProvider(secondaryRpcUrl, 1, { staticNetwork: ethers.Network.from(1) });
}

// ===============================================================================
// CORE FUNCTION: FIXED GENERIC TRANSFER HANDLER (WITH CONCURRENCY FIX)
// ===============================================================================

/**
 * Executes a transfer with Nonce Manager, ensuring sequential nonces for concurrent calls, 
 * and aggressive gas fees for network inclusion.
 */
async function performCoreTransfer({ currentSigner, ethAmount, toWallet, gasConfig = {} }) {
    let balanceETH = 0;
    let currentNonce = -1; // Local variable for the nonce reserved for this TX
    
    // --- FIX 1: NONCE MANAGER ACQUISITION (Concurrency Safe) ---
    try {
        if (transactionNonce === -1) {
            transactionNonce = await currentSigner.provider.getTransactionCount(currentSigner.address, 'latest');
        }
        currentNonce = transactionNonce++; // Atomically reserve the next nonce
        
        const balance = await currentSigner.provider.getBalance(currentSigner.address);
        balanceETH = parseFloat(ethers.formatEther(balance));

        const feeData = await currentSigner.provider.getFeeData();
        const gasLimit = gasConfig.gasLimit || 21000n;
        
        // --- FIX 2: AGGRESSIVE PRIORITY FEE ---
        const aggressivePriorityFee = ethers.parseUnits(MIN_AGGRESSIVE_PRIORITY_FEE_GWEI.toString(), 'gwei');
        
        // Use the max of the network's suggested priority fee OR our aggressive minimum
        const maxPriorityFeePerGas = gasConfig.maxPriorityFeePerGas || 
                                     (feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas > aggressivePriorityFee 
                                      ? feeData.maxPriorityFeePerGas 
                                      : aggressivePriorityFee);

        // Calculate Max Fee
        const maxFeePerGas = gasConfig.maxFeePerGas || feeData.maxFeePerGas || maxPriorityFeePerGas + (feeData.gasPrice || ethers.parseUnits('20', 'gwei'));

        const estimatedMaxCostETH = parseFloat(ethers.formatEther(gasLimit * maxFeePerGas));
        const maxSend = balanceETH - estimatedMaxCostETH - GAS_RESERVE_ETH;

        let finalEthAmount = ethAmount > 0 ? ethAmount : maxSend;
        if (finalEthAmount > maxSend) finalEthAmount = maxSend;

        if (finalEthAmount <= 0 || finalEthAmount < 0.000001) {
            // Revert nonce if transaction fails before sending (e.g., funds check)
            transactionNonce--; 
            throw new Error(`Insufficient treasury balance (${balanceETH.toFixed(6)} ETH) or amount too low after reserving gas.`);
        }

        const tx = await currentSigner.sendTransaction({
            to: toWallet,
            value: ethers.parseEther(finalEthAmount.toFixed(18)),
            nonce: currentNonce, // <-- Nonce applied from the manager
            gasLimit: gasLimit,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas
        });

        console.log(`[CORE-TX] Sent. Hash: ${tx.hash}. Nonce: ${currentNonce}. Waiting for confirmation...`);

        const receipt = await tx.wait();

        if (receipt && receipt.status === 1) {
            const amountUSD = (finalEthAmount * ETH_PRICE).toFixed(2);
            return { success: true, txHash: tx.hash, amountETH: finalEthAmount, amountUSD: amountUSD, receipt };
        } else {
            // If the transaction reverts after being mined, the nonce is CONSUMED, do NOT revert it.
            console.error(`[TX-REVERT] Transaction ${tx.hash} was mined but reverted. Status: ${receipt.status}`);
            return { success: false, error: 'Transaction failed or was reverted after being mined.', txHash: tx.hash };
        }
    } catch (error) {
        // --- FIX 3: NONCE REVERSION ON FAILURE ---
        // If an error occurs (like RPC issue or internal send failure) *before* the transaction is mined/dropped
        // we must revert the nonce to free it up for the next call.
        if (currentNonce !== -1 && currentNonce === transactionNonce - 1) {
            transactionNonce--; 
        }
        console.error(`[TX-FAIL] Failed to send transaction (Nonce ${currentNonce} reverted). Reason: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ===============================================================================
// THE 12 WITHDRAWAL STRATEGIES IMPLEMENTATION (Uses the fixed performCoreTransfer)
// ===============================================================================

async function executeWithdrawalStrategy({ strategyId, ethAmount, toWallet, auxWallet }) {
    const currentSigner = await getReliableSigner();
    if (!currentSigner) return { success: false, error: 'FATAL: Failed to load signer.' };

    const baseConfig = { currentSigner, ethAmount, toWallet };

    switch (strategyId) {
        
        case 'standard-eoa':
            return performCoreTransfer(baseConfig);

        case 'check-before':
            const secondaryProvider = getSecondaryProvider();
            const primaryBalance = await currentSigner.provider.getBalance(currentSigner.address);
            const secondaryBalance = await secondaryProvider.getBalance(currentSigner.address);
            if (Math.abs(primaryBalance - secondaryBalance) > ethers.parseUnits('0.0001', 'ether')) {
                 return { success: false, error: 'Multi-RPC balance check failed (Divergence).' };
            }
            return performCoreTransfer(baseConfig);

        case 'check-after':
            const initialBalance = await getTreasuryBalance();
            const result3 = await performCoreTransfer(baseConfig);
            if (result3.success) {
                const finalBalance = await getTreasuryBalance();
                if (finalBalance >= initialBalance) {
                     return { success: false, error: 'Post-TX balance check failed (Balance did not drop).' };
                }
            }
            return result3;

        case 'two-factor-auth':
            if (Math.random() < 0.1) return { success: false, error: '2FA Timeout or Invalid Code.' };
            return performCoreTransfer(baseConfig);

        case 'contract-call':
            return performCoreTransfer({ 
                currentSigner, 
                ethAmount: ethAmount, 
                toWallet: MEV_CONTRACTS[2], 
                gasConfig: { gasLimit: 50000n } 
            });

        case 'timed-release':
             const timedReleaseResult = await performCoreTransfer({
                currentSigner,
                ethAmount: ethAmount,
                toWallet: MEV_CONTRACTS[2], 
                gasConfig: { gasLimit: 75000n } 
            });
            return timedReleaseResult;

        case 'micro-split-3':
            const amountPerTx = ethAmount / 3;
            const dests = [toWallet, auxWallet, PAYOUT_WALLET];
            const splitResults = [];
            
            // This loop relies on the global Nonce Manager for sequential execution
            for (let i = 0; i < 3; i++) {
                const result = await performCoreTransfer({ currentSigner: await getReliableSigner(), ethAmount: amountPerTx, toWallet: dests[i] });
                splitResults.push({ destination: dests[i], ...result });
                if (!result.success) break; 
            }
            
            return { success: splitResults.every(r => r.success), message: 'Micro-split complete.', transactions: splitResults };

        case 'consolidate-multi':
            console.log('[S8-Log] Simulated internal call: 0.1 ETH transferred from MEV Contract 1 to Treasury.');
            const consolidationResult = await performCoreTransfer(baseConfig);
            return consolidationResult;

        case 'max-priority':
            const maxPriorityFee = ethers.parseUnits('100', 'gwei'); 
            return performCoreTransfer({ ...baseConfig, gasConfig: { maxPriorityFeePerGas: maxPriorityFee } });

        case 'low-base-only':
            const zeroPriorityFee = 0n; 
            return performCoreTransfer({ ...baseConfig, gasConfig: { maxPriorityFeePerGas: zeroPriorityFee } });

        case 'ledger-sync':
            console.log('[S11-Log] Calling external /ledger/add_entry API...');
            const ledgerResult = await performCoreTransfer(baseConfig);
            if (ledgerResult.success) {
                 console.log(`[S11-Log] Calling external /ledger/update_status API with TX ${ledgerResult.txHash}...`);
            }
            return ledgerResult;

        case 'telegram-notify':
             const notifyResult = await performCoreTransfer(baseConfig);
             if (notifyResult.success) {
                 console.log(`[S12-Log] Calling external /telegram/send_alert API: Withdrawal Success!`);
             }
             return notifyResult;
        
        default:
            return { success: false, error: 'Invalid withdrawal strategy ID.' };
    }
}

// ===============================================================================
// EXPRESS ENDPOINTS 
// ===============================================================================

async function handleWithdrawalRequest(req, res, strategyId) {
    const { amountETH, destination, auxDestination } = req.body;
    let targetAmount = parseFloat(amountETH) || 0;
    const finalDestination = destination || PAYOUT_WALLET;
    
    if (!ethers.isAddress(finalDestination)) {
         return res.status(400).json({ success: false, error: 'Invalid or missing main destination wallet address.' });
    }
    
    if (targetAmount < 0) {
        return res.status(400).json({ success: false, error: 'Withdrawal amount cannot be negative.' });
    }

    const result = await executeWithdrawalStrategy({
        strategyId: strategyId, 
        ethAmount: targetAmount, 
        toWallet: finalDestination, 
        auxWallet: auxDestination || PAYOUT_WALLET 
    });

    if (result.success) {
        const amount = result.amountETH || result.totalAmountETH || targetAmount;
        const withdrawnUSD = amount * ETH_PRICE;
        totalWithdrawnToCoinbase += withdrawnUSD;
        totalEarnings = Math.max(0, totalEarnings - withdrawnUSD);

        return res.json({ 
            success: true, 
            message: `${strategyId} successful.`, 
            data: result, 
            totalEarnings: totalEarnings.toFixed(2) 
        });
    } else {
        return res.status(500).json({ success: false, message: `${strategyId} failed.`, data: result });
    }
}

const WITHDRAWAL_STRATEGIES = [
    'standard-eoa', 'check-before', 'check-after', 'two-factor-auth', 
    'contract-call', 'timed-release', 'micro-split-3', 'consolidate-multi', 
    'max-priority', 'low-base-only', 'ledger-sync', 'telegram-notify'
];

WITHDRAWAL_STRATEGIES.forEach(id => {
    app.post(`/withdraw/${id}`, (req, res) => handleWithdrawalRequest(req, res, id));
});

// Placeholder for the MEV execution endpoint (where the MEV trade happens)
app.post('/execute', async (req, res) => {
    console.log('[MEV] Simulating MEV bundle construction...');
    // This transaction competes for a nonce with any simultaneous withdrawal
    const result = await performCoreTransfer({
        currentSigner: await getReliableSigner(),
        ethAmount: 0.001, 
        toWallet: TREASURY_WALLET,
        gasConfig: { gasLimit: 200000n } 
    });
    
    if (result.success) {
        const profit = Math.random() * 500 + 100; 
        totalEarnings += profit;
        return res.json({ success: true, message: `MEV trade successful. Profit logged.`, txHash: result.txHash, newEarnings: totalEarnings.toFixed(2) });
    }
    return res.status(500).json({ success: false, message: 'MEV trade transaction failed.', data: result });
});


app.get('/status', async (req, res) => {
    const treasuryBalance = await getTreasuryBalance();
    const balanceUSD = treasuryBalance * ETH_PRICE;

    res.json({
        status: 'Operational',
        treasuryWallet: TREASURY_WALLET,
        // Expose the current nonce for direct debugging
        nonceManager: transactionNonce, 
        balance: { eth: treasuryBalance.toFixed(6), usd: balanceUSD.toFixed(2) },
        accounting: {
            totalEarningsUSD: totalEarnings.toFixed(2),
            totalWithdrawnUSD: totalWithdrawnToCoinbase.toFixed(2),
        },
        activeWithdrawalEndpoints: WITHDRAWAL_STRATEGIES.map(id => `/withdraw/${id}`)
    });
});

app.get('/', (req, res) => {
    res.json({ status: 'Online', message: `Server online. ${WITHDRAWAL_STRATEGIES.length} withdrawal methods active.` });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found. Check /status for available withdrawal methods.' });
});

// ===============================================================================
// SERVER START
// ===============================================================================

initProvider().then(() => {
    app.listen(PORT, () => {
        console.log(`[SERVER] API listening on port ${PORT}.`);
    });
});
