import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

// -----------------------------
// Types & Constants
// -----------------------------

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export interface SwapOptions {
  rpcUrl: string;
  wallet: Keypair;
  direction: "buy" | "sell";
  mint: PublicKey;
  amountRaw: string;
  amountIn: "sol" | "token";
  slippagePct?: number;
  dynamicSlippage?: boolean;
  priorityFeeSol?: number;
  autoPriorityFee?: boolean;
  priorityMode: "compute" | "jito";
  disableReferralFee: boolean;
  platformFeeBps?: number;
  feeAccount?: string;
  extraFeeSol?: number;
  extraFeeRecipient?: string;
  simulate: boolean;
  onProgress?: (log: string) => void;
}

export interface SwapResult {
  signature?: string;
  error?: any;
  quoteResponse: any;
  fees: {
    networkFeeSol: number;
    priorityFeeSol: number;
    totalFeeSol: number;
  };
  simulationLogs?: string[];
  unitsConsumed?: number;
  inputDecimals: number;
  outputDecimals: number;
  executionTimeMs?: number;
  actualOutAmountAtomic?: string;
}

// -----------------------------
// Helpers
// -----------------------------

function isPercent(s: string): boolean {
  return s.trim().endsWith("%");
}

function pctToFraction(s: string): number {
  const n = Number(s.trim().slice(0, -1));
  if (!isFinite(n) || n <= 0) throw new Error(`Invalid percentage: ${s}`);
  return n / 100;
}

async function getMintDecimalsOrSol(connection: Connection, mint: PublicKey): Promise<number> {
  if (mint.equals(SOL_MINT)) return 9;
  const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  return mintInfo.decimals;
}

function toAtomic(amount: number, decimals: number): bigint {
  const pow = BigInt(10) ** BigInt(decimals);
  const [intPart, fracPartRaw] = amount.toString().split(".");
  const fracPart = (fracPartRaw || "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(intPart || "0") * pow + BigInt(fracPart || "0");
}

async function getWalletBalanceAtomic(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  if (mint.equals(SOL_MINT)) {
    const lamports = await connection.getBalance(owner, "confirmed");
    return BigInt(lamports);
  }
  const ata = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);
  const info = await connection.getTokenAccountBalance(ata).catch(() => null);
  if (!info?.value) return BigInt(0);
  return BigInt(info.value.amount);
}

async function getAltAccounts(
  connection: Connection,
  keys: string[]
): Promise<AddressLookupTableAccount[]> {
  const infos = await connection.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
  const out: AddressLookupTableAccount[] = [];
  for (let i = 0; i < keys.length; i++) {
    const accountInfo = infos[i];
    if (accountInfo) {
      out.push(
        new AddressLookupTableAccount({
          key: new PublicKey(keys[i]),
          state: AddressLookupTableAccount.deserialize(accountInfo.data),
        })
      );
    }
  }
  return out;
}

function deSerIx(ix: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((k: any) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

// -----------------------------
// Core Swap Logic
// -----------------------------

export async function executeSwap(options: SwapOptions): Promise<SwapResult> {
  const startTime = performance.now();
  const {
    rpcUrl,
    wallet,
    direction,
    mint,
    amountRaw,
    amountIn,
    slippagePct,
    dynamicSlippage,
    priorityFeeSol,
    autoPriorityFee,
    priorityMode,
    disableReferralFee,
    platformFeeBps,
    feeAccount,
    extraFeeSol,
    extraFeeRecipient,
    simulate,
    onProgress,
  } = options;

  const connection = new Connection(rpcUrl, { commitment: "confirmed" });

  const inputMint = direction === "buy" ? SOL_MINT : mint;
  const outputMint = direction === "buy" ? mint : SOL_MINT;
  const swapMode = amountIn === (direction === "buy" ? "sol" : "token") ? "ExactIn" : "ExactOut";

  if (isPercent(amountRaw) && swapMode !== "ExactIn") {
    throw new Error(
      `Percentage amounts are only supported when --amount-in refers to the input side (ExactIn). ` +
        `You passed ${amountRaw} with swapMode=ExactOut.`
    );
  }

  const [inputDecimals, outputDecimals] = await Promise.all([
    getMintDecimalsOrSol(connection, inputMint),
    getMintDecimalsOrSol(connection, outputMint),
  ]);

  let atomicAmount: bigint;
  if (swapMode === "ExactIn") {
    let inputAmountSolOrToken: number;
    if (isPercent(amountRaw)) {
      const frac = pctToFraction(amountRaw);
      const balAtomic = await getWalletBalanceAtomic(connection, wallet.publicKey, inputMint);
      const asNumber = Number(balAtomic) / 10 ** inputDecimals;
      inputAmountSolOrToken = asNumber * frac;
    } else {
      inputAmountSolOrToken = Number(amountRaw);
    }
    atomicAmount = toAtomic(inputAmountSolOrToken, inputDecimals);
  } else {
    const outAmount = Number(amountRaw);
    atomicAmount = toAtomic(outAmount, outputDecimals);
  }

  const params = new URLSearchParams({
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    amount: atomicAmount.toString(),
    restrictIntermediateTokens: "true",
    swapMode,
  });

  if (dynamicSlippage) {
    params.append("autoSlippage", "true");
  } else if (slippagePct) {
    params.append("slippageBps", Math.round(slippagePct * 100).toString());
  }

  if (!disableReferralFee && platformFeeBps && platformFeeBps > 0) {
    params.set("platformFeeBps", String(platformFeeBps));
  }

  // --- Phase 1: Send Transaction (with retries) ---
  const maxSendAttempts = 4;
  const sendRetryInterval = 2000; // 2s
  let sendAttempts = 0;
  let lastError: any = null;
  let signature: string | undefined;
  let quoteResponse: any; // To store the quote from the successful attempt
  let preInputBalance: bigint | undefined;
  let preOutputBalance: bigint | undefined;

  onProgress?.(`Starting swap...`);

  while (sendAttempts < maxSendAttempts) {
    sendAttempts++;
    onProgress?.(`Attempt ${sendAttempts}/${maxSendAttempts} to send transaction...`);

    try {
      // 1. Get latest quote and instructions
      const QUOTE_URL = `https://lite-api.jup.ag/swap/v1/quote?${params.toString()}`;
      onProgress?.(`  Getting quote...`);
      const freshQuoteResponse = await fetch(QUOTE_URL).then((r) => r.json()) as any;
      if (freshQuoteResponse.error) throw new Error(`Quote error: ${freshQuoteResponse.error}`);
      quoteResponse = freshQuoteResponse; // Store the latest valid quote

      const swapInstrBody: any = {
        quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        dynamicComputeUnitLimit: true,
        wrapAndUnwrapSol: true,
      };

      if (autoPriorityFee) {
        swapInstrBody.prioritizationFeeLamports = "auto";
      } else if (priorityFeeSol && priorityFeeSol > 0) {
        const lamports = Math.floor(priorityFeeSol * 1e9);
        if (priorityMode === "jito") {
          swapInstrBody.prioritizationFeeLamports = { jitoTipLamports: lamports };
        } else {
          swapInstrBody.prioritizationFeeLamports = {
            priorityLevelWithMaxLamports: { maxLamports: lamports, priorityLevel: "veryHigh", global: false },
          };
        }
      }

      if (!disableReferralFee && feeAccount) {
        swapInstrBody.feeAccount = feeAccount;
      }
      console.log(JSON.stringify(swapInstrBody, null, 2));
      onProgress?.(`  Getting swap instructions...`);
      const SWAP_INSTRUCTIONS_URL = "https://lite-api.jup.ag/swap/v1/swap-instructions";
      
      // Log as curl command
      const curlCommand = `curl -X POST "${SWAP_INSTRUCTIONS_URL}" \\
      -H "Content-Type: application/json" \\
      -d '${JSON.stringify(swapInstrBody, null, 2)}'`;
      console.log("Curl equivalent:");
      console.log(curlCommand);
      
      const instructionsRes = await fetch(SWAP_INSTRUCTIONS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(swapInstrBody),
      }).then((r) => r.json()) as any;

      if (instructionsRes.error) {
        throw new Error(`Failed to get swap instructions: ${instructionsRes.error}`);
      }

      // 2. Build transaction
      const {
        computeBudgetInstructions,
        setupInstructions,
        swapInstruction: swapInstructionPayload,
        cleanupInstruction,
        addressLookupTableAddresses,
      } = instructionsRes;

      const ixs: TransactionInstruction[] = [];
      if (computeBudgetInstructions?.length) for (const ix of computeBudgetInstructions) ixs.push(deSerIx(ix));
      if (extraFeeSol && extraFeeSol > 0) {
        if (!extraFeeRecipient) throw new Error("--fee-recipient is required when using --fee");
        ixs.push(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(extraFeeRecipient), lamports: Math.floor(extraFeeSol * 1e9) }));
      }
      if (setupInstructions?.length) for (const ix of setupInstructions) ixs.push(deSerIx(ix));
      ixs.push(deSerIx(swapInstructionPayload));
      if (cleanupInstruction) ixs.push(deSerIx(cleanupInstruction));

      const [altAccounts, { blockhash }] = await Promise.all([
        getAltAccounts(connection, addressLookupTableAddresses || []),
        connection.getLatestBlockhash("finalized")
      ]);

      const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message(altAccounts);
      const tx = new VersionedTransaction(message);
      tx.sign([wallet]);

      // 3. Handle simulation (which doesn't need retries or confirmation)
      if (simulate) {
        const sim = await connection.simulateTransaction(tx, {
          sigVerify: false,
          commitment: "processed",
          replaceRecentBlockhash: true,
        });

        let fees = { networkFeeSol: 0, priorityFeeSol: 0, totalFeeSol: 0 };
        if (!sim.value.err) {
          const networkFeeLamports = (await connection.getFeeForMessage(tx.message, "confirmed")).value || 0;
          let priorityFeeLamports = 0;
          const computeBudgetIxs = instructionsRes.computeBudgetInstructions || [];
          const setPriceIx = computeBudgetIxs.find((ix: any) => Buffer.from(ix.data, "base64")[0] === 3);
          if (setPriceIx) {
            const dataBuffer = Buffer.from(setPriceIx.data, "base64");
            const priceMicroLamports = dataBuffer.readBigUInt64LE(1);
            const unitsConsumed = sim.value.unitsConsumed || 0;
            priorityFeeLamports = Number((priceMicroLamports * BigInt(unitsConsumed)) / 1000000n);
          }
          fees.networkFeeSol = networkFeeLamports / 1e9;
          fees.priorityFeeSol = priorityFeeLamports / 1e9;
          fees.totalFeeSol = fees.networkFeeSol + fees.priorityFeeSol;
        }
        const endTime = performance.now();
        return {
          error: sim.value.err,
          quoteResponse,
          fees,
          simulationLogs: sim.value.logs || undefined,
          unitsConsumed: sim.value.unitsConsumed,
          inputDecimals,
          outputDecimals,
          executionTimeMs: endTime - startTime,
        };
      }

      // 4. Capture pre-transaction balances before sending
      [preInputBalance, preOutputBalance] = await Promise.all([
        getWalletBalanceAtomic(connection, wallet.publicKey, inputMint),
        getWalletBalanceAtomic(connection, wallet.publicKey, outputMint)
      ]);
      onProgress?.(`  Pre-transaction input balance: ${preInputBalance.toString()}`);
      onProgress?.(`  Pre-transaction output balance: ${preOutputBalance.toString()}`);

      // 5. Send the transaction
      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
      onProgress?.(`  Transaction sent successfully with signature: ${signature}`);
      break; // Exit send loop on success

    } catch (error: any) {
      lastError = error;
      onProgress?.(`  Attempt ${sendAttempts} failed: ${error.message || error}`);
      if (sendAttempts >= maxSendAttempts) {
        throw new Error(`Failed to send transaction after ${maxSendAttempts} attempts. Last error: ${lastError?.message || lastError}`);
      }
      await new Promise((resolve) => setTimeout(resolve, sendRetryInterval));
    }
  }

  if (!signature) {
    throw new Error(`Transaction was not sent after ${maxSendAttempts} attempts.`);
  }

  // --- Phase 2: Confirm Transaction ---
  onProgress?.(`\nTransaction sent. Waiting for confirmation...`);
  const confirmationTimeout = 20000; // 20s for confirmation

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), confirmationTimeout);
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight, abortSignal: controller.signal }, "finalized");
    clearTimeout(timeoutId);

    if (confirmation.value.err) {
      throw new Error(`Transaction confirmed with error: ${JSON.stringify(confirmation.value.err)}`);
    }

    onProgress?.(`  ✅ Transaction confirmed successfully!`);
    
    // Add a small delay to ensure balances are updated
    onProgress?.(`  Waiting for balance updates...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Success
    let actualNetworkFeeSol = 0;
    let actualOutAmountAtomic: bigint | undefined;

    if (preInputBalance !== undefined && preOutputBalance !== undefined) {
      // Get wallet balances after transaction to calculate actual amounts
      onProgress?.(`  Fetching post-transaction balances...`);
      try {
        
        const [postInputBalance, postOutputBalance] = await Promise.all([
          getWalletBalanceAtomic(connection, wallet.publicKey, inputMint),
          getWalletBalanceAtomic(connection, wallet.publicKey, outputMint)
        ]);
        
        onProgress?.(`  Post-transaction input balance: ${postInputBalance.toString()}`);
        onProgress?.(`  Post-transaction output balance: ${postOutputBalance.toString()}`);
        
        // Calculate actual amounts from balance changes
        const inputSpent = preInputBalance - postInputBalance;
        const outputReceived = postOutputBalance - preOutputBalance;
        
        onProgress?.(`  Input spent: ${inputSpent.toString()}`);
        onProgress?.(`  Output received: ${outputReceived.toString()}`);
        
        // For our purposes, we want the actual output amount received
        actualOutAmountAtomic = outputReceived;
        
        // For SOL transactions, we need to account for network fees
        if (outputMint.equals(SOL_MINT)) {
          // When selling for SOL, we need to add back the network fee to get the true amount received from the swap
          // since the balance change already deducted the fee
          const estimatedNetworkFee = BigInt(15000); // 0.000015 SOL in lamports (typical fee)
          actualOutAmountAtomic = outputReceived + estimatedNetworkFee;
          onProgress?.(`  Adjusted SOL output for network fee: ${actualOutAmountAtomic.toString()}`);
        }
        
        onProgress?.(`  ✅ Final actual output amount: ${actualOutAmountAtomic.toString()}`);
        
        // Try to get exact network fee from transaction details (but don't fail if this breaks)
        try {
          const txDetails = await connection.getParsedTransaction(signature, { 
            commitment: "finalized", 
            maxSupportedTransactionVersion: 1 
          });
          if (txDetails?.meta?.fee) {
            actualNetworkFeeSol = txDetails.meta.fee / 1e9;
            onProgress?.(`  ✅ Exact network fee: ${actualNetworkFeeSol} SOL`);
            
            // Recalculate SOL output with exact fee if available
            if (outputMint.equals(SOL_MINT)) {
              const exactFeeAtomic = BigInt(txDetails.meta.fee);
              actualOutAmountAtomic = outputReceived + exactFeeAtomic;
              onProgress?.(`  ✅ Recalculated SOL output with exact fee: ${actualOutAmountAtomic.toString()}`);
            }
          }
        } catch (feeError: any) {
          onProgress?.(`  Could not get exact network fee, using estimated: ${feeError.message}`);
          actualNetworkFeeSol = 0.000015; // Use our estimate
        }

      } catch (balanceError: any) {
        onProgress?.(`  Error fetching post-transaction balances: ${balanceError.message}`);
        // Fall back to undefined so we use expected amounts
        actualOutAmountAtomic = undefined;
      }
    }

    const endTime = performance.now();
    const executionTimeMs = endTime - startTime;

    return {
      signature,
      quoteResponse,
      fees: { networkFeeSol: actualNetworkFeeSol, priorityFeeSol: 0, totalFeeSol: actualNetworkFeeSol },
      inputDecimals,
      outputDecimals,
      executionTimeMs,
      actualOutAmountAtomic: actualOutAmountAtomic?.toString(),
    };

  } catch (error: any) {
    onProgress?.(`\nConfirmation failed or timed out: ${error.message || error}`);
    // If confirmation fails, return an uncertain result. DO NOT RETRY SWAP.
    return {
      signature,
      error: `Transaction confirmation failed. The swap may or may not have succeeded. Please check the block explorer for signature: ${signature}`,
      quoteResponse,
      fees: { networkFeeSol: 0, priorityFeeSol: 0, totalFeeSol: 0 },
      inputDecimals,
      outputDecimals,
      executionTimeMs: performance.now() - startTime,
    };
  }
}

