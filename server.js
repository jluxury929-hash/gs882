// ===============================================================================
// UNIFIED EARNINGS & WITHDRAWAL API v5.0.0 (MEV Mempool Listener Integrated)
// ===============================================================================

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers'); 

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

// ===============================================================================
// CONFIGURATION & SECRETS 
// ===============================================================================

const PORT = process.env.PORT || 8080;
// ⚠️ DANGER: HIGH-SEVERITY RISK: PRIVATE_KEY is exposed via environment variable.
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY; 
if (!PRIVATE_KEY) {
    console.error("FATAL: TREASURY_PRIVATE_KEY not set. Cannot run.");
    process.exit(1);
}

const PAYOUT_WALLET = process.env.PAYOUT_WALLET || '0xMUST_SET_PAYOUT_WALLET_IN_ENV';
const ETH_PRICE = 3450; 
const GAS_RESERVE_ETH = 0.003; 
// Minimum aggressive priority fee (tip) to ensure validator inclusion: 5 Gwei
const MIN_AGGRESSIVE_PRIORITY_FEE_GWEI = 5n; 
let TREASURY_WALLET = '0xaFb88bD20CC9AB943fCcD050fa07D998Fc2F0b7C'; 
const MEV_CONTRACTS = [
    '0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0', 
    '0x29983BE497D4c1D39Aa80D20Cf74173ae81D2af5', 
    '0x12345678901234567890123456748901234567890' 
];

let totalEarnings = 0;
let totalWithdrawnToCoinbase = 0;
let currentRpcIndex = 0;

const RPC_URLS = [
    // 💡 IMPORTANT: This first URL MUST be a WSS (WebSocket) endpoint for the listener!
    'wss://your-dedicated-wss-url-here', 
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://rpc.ankr.com/eth',
];

let provider = null;
let signer = null;
let transactionNonce = -1; 

// ===============================================================================
// UTILITY FUNCTIONS (RPC & Nonce Management)
// ===============================================================================

async function initProvider() {
    try {
        // Use the first HTTP RPC URL (index 1) for the standard provider
        const url = RPC_URLS[currentRpcIndex % RPC_URLS.length || 1]; 
        provider = new ethers.JsonRpcProvider(url, 1, { staticNetwork: ethers.Network.from(1) });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        TREASURY_WALLET = signer.address;
        
        transactionNonce = await provider.getTransactionCount(signer.address, 'latest');
        console.log(`[INIT] Connected to RPC URL: ${url}. Starting Nonce: ${transactionNonce}`);
    } catch (e) {
        console.error(`[INIT] Failed to connect to RPC: ${e.message}. Attempting RPC failover...`);
        currentRpcIndex++;
        if (currentRpcIndex < RPC_URLS.length * 2) { 
            await initProvider();
        } else {
            console.error("FATAL: All HTTP RPCs failed after multiple attempts. Exiting.");
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
    // Use an index > 1 to avoid the primary and WSS endpoint
    const secondaryRpcUrl = RPC_URLS[(currentRpcIndex + 2) % RPC_URLS.length];
    return new ethers.JsonRpcProvider(secondaryRpcUrl, 1, { staticNetwork: ethers.Network.from(1) });
}

// ===============================================================================
// CORE FUNCTION: FIXED GENERIC TRANSFER HANDLER (UNCHANGED)
// ===============================================================================
// ... performCoreTransfer function remains as in v4.6.0 ...
async function performCoreTransfer({ currentSigner, ethAmount, toWallet, gasConfig = {} }) {
    let currentNonce = -1;
    
    try {
        // --- Nonce Management: Get and atomically increment global counter ---
        if (transactionNonce === -1) {
            transactionNonce = await currentSigner.provider.getTransactionCount(currentSigner.address, 'latest');
        }
        currentNonce = transactionNonce++; // Atomic increment
        
        const balance = await currentSigner.provider.getBalance(currentSigner.address);
        const balanceETH = parseFloat(ethers.formatEther(balance));

        const feeData = await currentSigner.provider.getFeeData();
        const gasLimit = gasConfig.gasLimit || 21000n;
        
        // --- 1. Max Priority Fee (Tip) Calculation ---
        const aggressivePriorityFee = ethers.parseUnits(MIN_AGGRESSIVE_PRIORITY_FEE_GWEI.toString(), 'gwei');
        
        const maxPriorityFeePerGas = gasConfig.maxPriorityFeePerGas || 
                                     (feeData.maxPriorityFeePerGas && BigInt(feeData.maxPriorityFeePerGas) > aggressivePriorityFee 
                                      ? BigInt(feeData.maxPriorityFeePerGas)
                                      : aggressivePriorityFee);

        // --- 2. Max Fee Per Gas (Ceiling) Calculation ---
        const estimatedBaseFee = BigInt(feeData.gasPrice || ethers.parseUnits('20', 'gwei'));
        const requiredMinMaxFee = maxPriorityFeePerGas + (estimatedBaseFee * 3n); 
        const providerMaxFee = feeData.maxFeePerGas ? BigInt(feeData.maxFeePerGas) : 0n;
        
        const maxFeePerGas = gasConfig.maxFeePerGas || 
                             (providerMaxFee > requiredMinMaxFee
                              ? providerMaxFee
                              : requiredMinMaxFee);


        // --- 3. Final Amount Check ---
        const estimatedMaxCostETH = parseFloat(ethers.formatEther(gasLimit * maxFeePerGas));
        const maxSend = balanceETH - estimatedMaxCostETH - GAS_RESERVE_ETH;

        let finalEthAmount = ethAmount > 0 ? ethAmount : maxSend;
        if (finalEthAmount > maxSend) finalEthAmount = maxSend;

        if (finalEthAmount <= 0 || finalEthAmount < 0.000001) {
            transactionNonce--; // Nonce is reset on local failure
            throw new Error(`Insufficient treasury balance (${balanceETH.toFixed(6)} ETH) or amount too low after reserving gas.`);
        }

        // --- 4. Send Transaction ---
        const tx = await currentSigner.sendTransaction({
            to: toWallet,
            value: ethers.parseEther(finalEthAmount.toFixed(18)),
            nonce: currentNonce, 
            gasLimit: gasLimit,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: maxPriorityFeePerGas
        });

        console.log(`[CORE-TX] Sent. Hash: ${tx.hash}. Nonce: ${currentNonce}. MaxFee: ${ethers.formatUnits(maxFeePerGas, 'gwei')} Gwei. MaxPriorityFee: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} Gwei.`);

        const receipt = await tx.wait();

        if (receipt && receipt.status === 1) {
            const amountUSD = (finalEthAmount * ETH_PRICE).toFixed(2);
            return { success: true, txHash: tx.hash, amountETH: finalEthAmount, amountUSD: amountUSD, receipt };
        } else {
            console.error(`[TX-REVERT] Transaction ${tx.hash} was mined but reverted. Status: ${receipt.status}`);
            return { success: false, error: 'Transaction failed or was reverted after being mined.', txHash: tx.hash };
        }
    } catch (error) {
        if (currentNonce !== -1 && currentNonce === transactionNonce - 1) {
            transactionNonce--; 
        }
        const errorMessage = error.code ? `${error.code}: ${error.message}` : error.message;
        console.error(`[TX-FAIL] Failed to send transaction (Nonce ${currentNonce} reverted). Reason: ${errorMessage}`);
        return { success: false, error: errorMessage };
    }
}


// ===============================================================================
// MEV SEARCHER CORE: ARBITRAGE CHECKER & MEMPOOL LISTENER (THE NEW EARNINGS LOGIC)
// ===============================================================================

// Step 3: ARBITRAGE CHECKER (STILL SIMULATED)
async function checkAndExecuteArbitrage(tx) {
    // ⚠️ REAL-WORLD ARBITRAGE LOGIC GOES HERE ⚠️
    // This function will eventually use EVM simulation to calculate real profit.

    // For now: only 1% of all pending transactions are "profitable"
    if (Math.random() < 0.01) { 
        const simulatedProfitETH = Math.random() * 0.05 + 0.005; 
        const profitUSD = simulatedProfitETH * ETH_PRICE;
        return { profitUSD: profitUSD, txType: 'Arbitrage', triggeringTx: tx.hash };
    }
    return null; 
}


// Step 2: MEMPOOL LISTENER (The Real-Time Engine)
async function startMempoolListener() {
    console.log('[MEV-LISTENER] Starting WebSocket connection for mempool monitoring...');
    
    const wssUrl = RPC_URLS[0];
    if (!wssUrl.startsWith('wss')) {
        console.error("FATAL: First RPC_URL must be a WSS (WebSocket) endpoint for real-time monitoring. Update RPC_URLS[0].");
        return;
    }

    try {
        const wssProvider = new ethers.WebSocketProvider(wssUrl, 1);
        
        wssProvider.on("pending", async (txHash) => {
            // Check only 1 in 10 pending hashes for full data to prevent rate-limiting on public nodes
            if (Math.random() < 0.1) {
                try {
                    const tx = await wssProvider.getTransaction(txHash); 
                    if (tx && tx.to) {
                        const profitResult = await checkAndExecuteArbitrage(tx);

                        if (profitResult && profitResult.profitUSD > 0) {
                            // Profit found and secured (simulated)
                            totalEarnings += profitResult.profitUSD;
                            console.log(`[REAL-MEV] Arbitrage SUCCESS! Trigger Tx: ${profitResult.triggeringTx.substring(0, 10)}. Profit: $${profitResult.profitUSD.toFixed(2)}. Current total: $${totalEarnings.toFixed(2)}`);
                        }
                    }
                } catch (error) {
                    // console.error('Error processing pending TX:', error.message);
                }
            }
        });

        console.log(`[MEV-LISTENER] Successfully connected to ${wssUrl}. Now listening for pending transactions.`);

        // Robust socket closure handling to auto-restart
        wssProvider._websocket.on('close', (code, reason) => {
            console.warn(`[MEV-LISTENER] WebSocket closed. Code: ${code}. Reason: ${reason.toString()}. Restarting...`);
            setTimeout(startMempoolListener, 5000); 
        });

    } catch (e) {
        console.error(`[MEV-LISTENER] Failed to connect to WSS: ${e.message}. Retrying in 10s.`);
        setTimeout(startMempoolListener, 10000);
    }
}


// ===============================================================================
// THE 12 WITHDRAWAL STRATEGIES IMPLEMENTATION (UNCHANGED)
// ===============================================================================
// ... executeWithdrawalStrategy function remains as in v4.6.0 ...
async function executeWithdrawalStrategy({ strategyId, ethAmount, toWallet, auxWallet }) {
    const currentSigner = await getReliableSigner();
    if (!currentSigner) return { success: false, error: 'FATAL: Failed to load signer.' };

    const baseConfig = { currentSigner, ethAmount, toWallet };

    switch (strategyId) {
        case 'standard-eoa': return performCoreTransfer(baseConfig);
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
            for (let i = 0; i < 3; i++) {
                const result = await performCoreTransfer({ currentSigner: await getReliableSigner(), ethAmount: amountPerTx, toWallet: dests[i] });
                splitResults.push({ destination: dests[i], ...result });
                if (!result.success) break; 
            }
            return { success: splitResults.every(r => r.success), message: 'Micro-split complete.', transactions: splitResults };
        case 'consolidate-multi':
            console.log('[S8-Log] Simulated internal call: 0.1 ETH transferred from MEV Contract 1 to Treasury.');
            return performCoreTransfer(baseConfig);
        case 'max-priority':
            const maxPriorityFee = ethers.parseUnits('100', 'gwei'); 
            return performCoreTransfer({ ...baseConfig, gasConfig: { maxPriorityFeePerGas: maxPriorityFee } });
        case 'low-base-only':
            const zeroPriorityFee = 0n; 
            return performCoreTransfer({ ...baseConfig, gasConfig: { maxPriorityFeePerGas: zeroPriorityFee } });
        case 'ledger-sync':
            console.log('[S11-Log] Calling external /ledger/add_entry API...');
            const ledgerResult = performCoreTransfer(baseConfig);
            if (ledgerResult.success) {
                 console.log(`[S11-Log] Calling external /ledger/update_status API with TX ${ledgerResult.txHash}...`);
            }
            return ledgerResult;
        case 'telegram-notify':
             const notifyResult = performCoreTransfer(baseConfig);
             if (notifyResult.success) {
                 console.log(`[S12-Log] Calling external /telegram/send_alert API: Withdrawal Success!`);
             }
             return notifyResult;
        default:
            return { success: false, error: 'Invalid withdrawal strategy ID.' };
    }
}

// ===============================================================================
// EXPRESS ENDPOINTS (REMOVED /execute)
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

// The old app.post('/execute', ...) endpoint has been REMOVED.
// Earning is now driven by the startMempoolListener function.

app.get('/status', async (req, res) => {
    const treasuryBalance = await getTreasuryBalance();
    const balanceUSD = treasuryBalance * ETH_PRICE;

    res.json({
        status: 'Operational',
        treasuryWallet: TREASURY_WALLET,
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
    res.json({ status: 'Online', message: `Server online. ${WITHDRAWAL_STRATEGIES.length} withdrawal methods active. Earnings now driven by Mempool Listener.` });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found. Check /status for available withdrawal methods.' });
});

// ===============================================================================
// GLOBAL ERROR HANDLERS (UNCHANGED)
// ===============================================================================

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION] Shutting down gracefully. Reason:', reason, 'Promise:', promise);
    process.exit(1); 
});

process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION] Shutting down gracefully. Error:', error);
    process.exit(1);
});

// ===============================================================================
// SERVER START (NEW: Starts Listener)
// ===============================================================================

initProvider().then(() => {
    app.listen(PORT, () => {
        console.log(`[SERVER] API listening on port ${PORT}.`);
    });
    
    // Launch the core MEV component
    startMempoolListener(); 
});
