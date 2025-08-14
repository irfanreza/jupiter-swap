#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token';

import {
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getBuySolAmountFromTokenAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';

import {
  PumpAmmSdk,
  PumpAmmInternalSdk,
  pumpPoolAuthorityPda,
  poolPda,
  // optional pure quote helpers (some versions export these)
  buyQuoteInputInternal,
  sellBaseInputInternal,
} from '@pump-fun/pump-swap-sdk';

import BN from 'bn.js';
import fs from 'fs';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

/* ------------------------- CLI / utils ------------------------- */
type Args = Record<string, string | boolean | undefined>;
function args(): Args {
  const out: Args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a?.startsWith('--')) {
      const k = a.slice(2);
      const v =
        i + 1 < process.argv.length && !process.argv[i + 1]?.startsWith('--')
          ? process.argv[++i]
          : 'true';
      out[k] = v;
    }
  }
  return out;
}

function usage(): never {
  console.log(`
Usage:
  bun run pump-trade.ts --mint <MINT> --side <buy|sell>
    [--sol <SOL>] | [--tokens <AMOUNT|PERCENT>]
    --slippage <PERCENT> --priorityFeeSol <SOL_TIP>
    [--rpc <URL>]
    [--dryRun]  (alias: --simulate)
    [--privateKey "<base58|hex|[json array]>"] | [--keypair </path/to/id.json>]

Examples:
  # Dry-run buy 0.05 SOL
  bun run pump-trade.ts --mint <mint> --side buy --sol 0.05 --slippage 2 --priorityFeeSol 0.00003 --dryRun

  # Real sell 100%
  bun run pump-trade.ts --mint <mint> --side sell --tokens 100% --slippage 2 --priorityFeeSol 0.00003
`);
  process.exit(1);
}

/* ------------------------- Key loading ------------------------- */
function keypairFromAny(input: string): Keypair {
  const bytes = parsePrivateKeyString(input);
  return keypairFromBytes(bytes);
}
function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, 'utf8').trim();
  try {
    const arr = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    return Keypair.fromSecretKey(bs58.decode(raw));
  }
}
function parsePrivateKeyString(s: string): Uint8Array {
  const t = s.trim();
  if (!t) throw new Error('Empty --privateKey');
  if (t.startsWith('[')) {
    const arr = JSON.parse(t);
    return Uint8Array.from(arr);
  }
  if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) {
    const out = new Uint8Array(t.length / 2);
    for (let i = 0; i < t.length; i += 2)
      out[i / 2] = parseInt(t.slice(i, i + 2), 16);
    return out;
  }
  try {
    return bs58.decode(t);
  } catch {
    throw new Error(
      'Unrecognized private key format. Use base58, hex, or JSON array.'
    );
  }
}
function keypairFromBytes(raw: Uint8Array): Keypair {
  if (raw.length === 64) return Keypair.fromSecretKey(raw);
  if (raw.length === 32) {
    const kp = nacl.sign.keyPair.fromSeed(raw);
    return Keypair.fromSecretKey(kp.secretKey);
  }
  throw new Error(`Private key must be 32 or 64 bytes (got ${raw.length}).`);
}

/* ------------------------- Pump PDAs ------------------------- */
const PUMP_PROGRAM_ID = new PublicKey(
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
);
function bondingCurvePda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return pda;
}

/* ------------------------- Helpers ------------------------- */
const PUMP_DECIMALS = 6;
function toLamports(sol: number): bigint {
  return BigInt(Math.floor(sol * LAMPORTS_PER_SOL));
}
function toBNLamports(sol: number): BN {
  return new BN(Math.floor(sol * LAMPORTS_PER_SOL));
}
function toBNRawTokens(amountUi: number): BN {
  return new BN(Math.round(amountUi * 10 ** PUMP_DECIMALS));
}
async function tryGetTokenBalanceRaw(
  connection: Connection,
  mint: PublicKey,
  owner: PublicKey
): Promise<bigint> {
  try {
    const ata = await getAssociatedTokenAddress(
      mint,
      owner,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const bal = await connection.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}
function fmt(n: number, digits = 6) {
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : n;
}

function printSim(sim: any) {
  const v = sim?.value ?? sim;
  console.log('—— Simulation ——');
  console.log('err:', v?.err ?? null);
  if (typeof v?.unitsConsumed === 'number')
    console.log('compute units:', v.unitsConsumed);
  if (v?.logs) {
    console.log('logs:');
    for (const line of v.logs) console.log('  ', line);
  }
  if (v?.returnData) {
    const { programId, data } = v.returnData;
    console.log('returnData.programId:', programId);
    try {
      const [b64] = data as [string, string];
      console.log('returnData (base64):', b64);
    } catch {}
  }
  console.log('———————');
}

/* ------------------------- Main ------------------------- */
(async () => {
  // Start timing the entire process
  const processStartTime = Date.now();
  console.log(`⏱️  Process started at: ${new Date().toLocaleTimeString()}`);

  const a = args();
  const mintStr = String(a.mint ?? '');
  const side = String(a.side ?? 'buy').toLowerCase() as 'buy' | 'sell';
  const solArg = a.sol !== undefined ? parseFloat(String(a.sol)) : undefined;
  const tokensStr =
    a.tokens !== undefined ? String(a.tokens).trim() : undefined;
  const slippagePct =
    a.slippage !== undefined ? parseFloat(String(a.slippage)) : undefined;
  const priorityFeeSol =
    a.priorityFeeSol !== undefined
      ? parseFloat(String(a.priorityFeeSol))
      : undefined;
  const rpc = String(
    a.rpc ?? process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com'
  );

  const dryRun = a.dryRun !== undefined || a.simulate !== undefined; // --dryRun or --simulate

  const privateKeyStr =
    (a.privateKey as string | undefined) ??
    process.env.PRIVATE_KEY ??
    process.env.PRIVATE_KEY_B58 ??
    '';
  const keypairPath = String(a.keypair ?? process.env.SOLANA_KEYPAIR ?? '');

  if (
    !mintStr ||
    !side ||
    slippagePct === undefined ||
    priorityFeeSol === undefined
  ) {
    usage();
  }
  if (side === 'buy' && solArg === undefined && tokensStr === undefined) {
    console.error(
      'For buy: pass either --sol <amount in SOL> or --tokens <amount>'
    );
    process.exit(1);
  }
  if (side === 'sell' && !tokensStr) {
    console.error('For sell: pass --tokens <amount|PERCENT>');
    process.exit(1);
  }

  // Keypair
  let payer: Keypair;
  if (privateKeyStr) payer = keypairFromAny(privateKeyStr);
  else if (keypairPath) payer = loadKeypair(keypairPath);
  else
    throw new Error(
      'Provide --privateKey "<base58|hex|[json array]>" or --keypair <path>'
    );

  const connection = new Connection(rpc, 'confirmed');
  const mint = new PublicKey(mintStr);

  // Get initial SOL balance for cost tracking
  const initialBalance = await connection.getBalance(payer.publicKey);
  console.log(
    `💰 Initial SOL balance: ${(initialBalance / LAMPORTS_PER_SOL).toFixed(
      6
    )} SOL`
  );

  // SDKs
  const pump = new PumpSdk(connection);
  const amm = new PumpAmmSdk(connection);
  const ammInternal = new PumpAmmInternalSdk(connection);

  // Fetch Pump global + curve state
  const global: any =
    (await (pump as any).getGlobal?.()) ??
    (await (pump as any).fetchGlobal?.());
  const bondingCurve: any =
    (await (pump as any).cachedBondingCurve?.(mint)) ??
    (await (pump as any).fetchBondingCurve?.(mint));

  // Curve PDA and account info (if missing, likely graduated)
  const curvePda = bondingCurvePda(mint);
  const bondingCurveAccountInfo = await connection.getAccountInfo(curvePda);

  // Decide route: if curve is complete OR account missing → AMM
  const curveComplete = Boolean(
    (bondingCurve &&
      (bondingCurve.complete ?? (bondingCurve as any).isComplete)) ||
      !bondingCurveAccountInfo
  );

  // Slippage (bps)
  const slippageBps = Math.max(0, Math.round(Number(slippagePct) * 100));

  // Priority fee: translate a TOTAL SOL tip to microLamports per CU
  const computeUnitLimit = 200_000; // heuristic
  const totalTipLamports = Math.max(0, Number(toLamports(priorityFeeSol!)));
  const microLamportsPerCU = Math.max(
    1,
    Math.floor((totalTipLamports * 1_000_000) / computeUnitLimit)
  );
  const feeIxs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamportsPerCU,
    }),
  ];

  // Preload user's ATA AccountInfo (can be null)
  let associatedUserAccountInfo: any = null;
  try {
    const userAta = await getAssociatedTokenAddress(
      mint,
      payer.publicKey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    associatedUserAccountInfo = await connection
      .getAccountInfo(userAta)
      .catch(() => null);
  } catch {}

  /* ---------------------- QUOTE + INSTRUCTIONS ---------------------- */
  let ixs: TransactionInstruction[] = [];
  let quote: any = {};

  if (!curveComplete) {
    // =========================== Bonding Curve ===========================
    if (side === 'buy') {
      if (solArg !== undefined) {
        const solIn = toBNLamports(solArg);
        const tokenOutBN = getBuyTokenAmountFromSolAmount(
          global,
          bondingCurve,
          solIn
        );
        const minOut = tokenOutBN
          .mul(new BN(10_000 - slippageBps))
          .div(new BN(10_000));

        quote = {
          route: 'Pump (bonding curve)',
          side,
          in: { sol: fmt(solArg, 6) },
          out: { tokens: fmt(tokenOutBN.toNumber() / 10 ** PUMP_DECIMALS) },
          slippagePct,
          minOutTokens: fmt(minOut.toNumber() / 10 ** PUMP_DECIMALS),
          priorityFeeSol,
        };

        ixs = await (pump as any).buyInstructions({
          global,
          bondingCurveAccountInfo,
          bondingCurve,
          associatedUserAccountInfo,
          mint,
          user: payer.publicKey,
          amount: tokenOutBN, // tokens (BN)
          solAmount: solIn, // lamports (BN)
          slippage: slippageBps,
        });
      } else {
        // buy by target token amount
        const tokenOutBN = toBNRawTokens(Number(tokensStr));
        const solNeeded = getBuySolAmountFromTokenAmount(
          global,
          bondingCurve,
          tokenOutBN
        );
        const maxSol = solNeeded
          .mul(new BN(10_000 + slippageBps))
          .div(new BN(10_000));

        quote = {
          route: 'Pump (bonding curve)',
          side,
          in: { solMax: fmt(maxSol.toNumber() / LAMPORTS_PER_SOL) },
          out: { tokens: fmt(tokenOutBN.toNumber() / 10 ** PUMP_DECIMALS) },
          estSolIn: fmt(solNeeded.toNumber() / LAMPORTS_PER_SOL),
          slippagePct,
          priorityFeeSol,
        };

        ixs = await (pump as any).buyInstructions({
          global,
          bondingCurveAccountInfo,
          bondingCurve,
          associatedUserAccountInfo,
          mint,
          user: payer.publicKey,
          amount: tokenOutBN,
          solAmount: maxSol,
          slippage: slippageBps,
        });
      }
    } else {
      // Always refetch fresh curve account
      const curvePdaFresh = bondingCurvePda(mint);
      const bondingCurveAccountInfoFresh = await connection.getAccountInfo(
        curvePdaFresh
      );
      if (!bondingCurveAccountInfoFresh)
        throw new Error(
          'Bonding curve account not found; token may have graduated.'
        );

      // (NEW) read actual decimals from the mint instead of assuming 6
      const { getMint } = await import('@solana/spl-token');
      const mintInfo = await getMint(connection, mint);
      const DECIMALS = mintInfo.decimals ?? 6;

      // Amount in base units using real decimals
      const toBNRaw = (ui: number) => new BN(Math.round(ui * 10 ** DECIMALS));

      let tokenInBN: BN;
      if (tokensStr!.endsWith('%')) {
        const pct = Number(tokensStr!.replace('%', ''));
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100)
          throw new Error('Invalid percentage for --tokens');
        const ata = await getAssociatedTokenAddress(
          mint,
          payer.publicKey,
          false,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const bal = await connection
          .getTokenAccountBalance(ata)
          .catch(() => null);
        const raw = BigInt(bal?.value?.amount ?? '0');
        if (raw === 0n) throw new Error('No token balance');
        tokenInBN = new BN(
          ((raw * BigInt(Math.floor(pct * 100))) / 10000n).toString()
        );
      } else {
        tokenInBN = toBNRaw(Number(tokensStr));
      }

      // Estimate *expected* lamports out (SDK helper)
      const estSolOut = getSellSolAmountFromTokenAmount(
        global,
        bondingCurve,
        tokenInBN
      );

      // For display only, not passed as min
      const minOutDisplay = estSolOut
        .mul(new BN(10_000 - slippageBps))
        .div(new BN(10_000));

      // Calculate display amount for tokens
      const tokenAmountForDisplay = tokenInBN.toNumber() / 10 ** DECIMALS;

      quote = {
        route: 'Pump (bonding curve)',
        side,
        in: { tokens: tokenAmountForDisplay },
        out: { sol: estSolOut.toNumber() / LAMPORTS_PER_SOL },
        minOutSol: minOutDisplay.toNumber() / LAMPORTS_PER_SOL,
        slippagePct,
        priorityFeeSol,
      };

      // The pump program seems to have very restrictive internal slippage protection
      // Use a much smaller slippage value for the program, while keeping user's slippage for display
      const programSlippage = Math.min(slippageBps, 100); // Cap at 1% for program

      if (slippageBps > 100) {
        console.log(
          `⚠️  Warning: Pump program has strict slippage limits. Using 1% internally instead of ${slippagePct}%`
        );
      }

      // IMPORTANT: pass the *estimate* as solAmount; the program will apply slippage guard
      try {
        ixs = await (pump as any).sellInstructions({
          global,
          bondingCurveAccountInfo: bondingCurveAccountInfoFresh,
          bondingCurve,
          associatedUserAccountInfo,
          mint,
          user: payer.publicKey,
          amount: tokenInBN, // tokens in (BN)
          solAmount: estSolOut, // expected SOL out (BN) — NOT pre-slippage min
          slippage: programSlippage, // Use conservative slippage for program
        });
      } catch {
        // Positional fallback for older SDKs (same semantics: pass estimate + slippage)
        ixs = await (pump as any).sellInstructions(
          global,
          bondingCurveAccountInfoFresh,
          mint,
          payer.publicKey,
          tokenInBN,
          estSolOut,
          programSlippage
        );
      }
    }
  } else {
    // =========================== PumpSwap (AMM) ===========================
    const [poolAuthority] = pumpPoolAuthorityPda(mint);
    const [pool] = poolPda(0, poolAuthority, mint, NATIVE_MINT);

    // Build swap state (required by internal SDK)
    const amm = new PumpAmmSdk(connection);
    const ammInternal = new PumpAmmInternalSdk(connection);
    const swapState = await amm.swapSolanaState(pool, payer.publicKey);

    // Optional human-readable quotes (if helpers exported in your version)
    const baseReserve: BN = (swapState as any).poolBaseAmount;
    const quoteReserve: BN = (swapState as any).poolQuoteAmount;
    const globalCfg: any = (swapState as any).globalConfig;
    const creator: PublicKey = (swapState as any).pool.creator;

    if (side === 'buy') {
      if (solArg === undefined)
        throw new Error('For AMM buy, pass --sol <amount>');
      const quoteInLamportsBN = toBNLamports(solArg);

      let tokenOutUi: number | undefined;
      try {
        const r = buyQuoteInputInternal(
          quoteInLamportsBN,
          slippageBps,
          baseReserve,
          quoteReserve,
          globalCfg,
          creator
        );
        tokenOutUi = r.base.toNumber() / 10 ** PUMP_DECIMALS;
      } catch {}

      quote = {
        route: 'PumpSwap (AMM)',
        side,
        in: { sol: fmt(solArg) },
        out: { tokens: tokenOutUi ?? 'slippage-guarded' },
        slippagePct,
        priorityFeeSol,
      };

      ixs = await ammInternal.buyQuoteInput(
        swapState,
        quoteInLamportsBN,
        slippageBps
      );
    } else {
      let tokenInBN: BN;
      if (tokensStr!.endsWith('%')) {
        const pct = Number(tokensStr!.replace('%', ''));
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          throw new Error('Invalid percent for --tokens');
        }
        const balRaw = await tryGetTokenBalanceRaw(
          connection,
          mint,
          payer.publicKey
        );
        if (balRaw === 0n) throw new Error('No token balance');
        tokenInBN = new BN(
          ((balRaw * BigInt(Math.floor(pct * 100))) / 10000n).toString()
        );
      } else {
        tokenInBN = toBNRawTokens(Number(tokensStr));
      }

      let solOutUi: number | undefined;
      try {
        const r = sellBaseInputInternal(
          tokenInBN,
          slippageBps,
          baseReserve,
          quoteReserve,
          globalCfg,
          creator
        );
        solOutUi = r.uiQuote.toNumber() / LAMPORTS_PER_SOL;
      } catch {}

      // Calculate display amount for tokens
      const tokenAmountForDisplay = tokenInBN.toNumber() / 10 ** PUMP_DECIMALS;

      quote = {
        route: 'PumpSwap (AMM)',
        side,
        in: { tokens: tokenAmountForDisplay },
        out: { sol: solOutUi ?? 'slippage-guarded' },
        slippagePct,
        priorityFeeSol,
      };

      // AMM also seems to have strict slippage protection, similar to bonding curve
      const ammSlippage = Math.min(slippageBps, 100); // Cap at 1% for AMM as well

      if (slippageBps > 100) {
        console.log(
          `⚠️  Warning: PumpSwap AMM has strict slippage limits. Using 1% internally instead of ${slippagePct}%`
        );
      }

      ixs = await ammInternal.sellBaseInput(swapState, tokenInBN, ammSlippage);
    }
  }

  /* --------------------------- Print quote --------------------------- */
  console.log('========== QUOTE ==========');
  console.log(JSON.stringify(quote, null, 2));
  if (quote.side === 'buy') {
    console.log(
      `🔄 Swap ${quote.in.sol.toFixed(8)} SOL for ${quote.out.tokens.toFixed(
        6
      )} tokens`
    );
    console.log(
      `💲 Price ${(quote.in.sol / quote.out.tokens).toFixed(12)} tokens per SOL`
    );
  } else {
    console.log(
      `🔄 Swap ${quote.in.tokens.toFixed(6)} tokens for ${quote.out.sol.toFixed(
        8
      )} SOL`
    );
    console.log(
      `💲 Price ${(quote.out.sol / quote.in.tokens).toFixed(12)} SOL per token`
    );
  }
  console.log('===========================');

  /* --------------------------- Build tx --------------------------- */
  const buildAndSendTransaction = async (retries = 3): Promise<void> => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Get fresh blockhash for each attempt
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash('processed');

        const msg = new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: blockhash,
          instructions: [...feeIxs, ...ixs],
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        tx.sign([payer]); // sign even for simulation (sigVerify true)

        /* --------------------------- Send or simulate --------------------------- */
        if (dryRun) {
          const simStartTime = Date.now();
          const sim = await connection.simulateTransaction(tx, {
            sigVerify: true,
            commitment: 'processed',
          });
          const simEndTime = Date.now();
          const simDuration = simEndTime - simStartTime;

          printSim(sim);
          console.log(`⏱️  Simulation completed in: ${simDuration}ms`);

          if (sim.value?.err) {
            console.error('❌ Simulation failed.');
            process.exit(1);
          } else {
            const processEndTime = Date.now();
            const totalProcessDuration = processEndTime - processStartTime;

            console.log('✅ Simulation succeeded (no transaction sent).');
            console.log(
              `📊 Total process duration: ${totalProcessDuration}ms (${(
                totalProcessDuration / 1000
              ).toFixed(2)}s)`
            );
            process.exit(0);
          }
        } else {
          console.log('📤 Sending transaction...');
          const txStartTime = Date.now();

          const sig = await connection.sendTransaction(tx, {
            skipPreflight: false,
            maxRetries: 3,
            preflightCommitment: 'confirmed',
          });

          const txSentTime = Date.now();
          const sendDuration = txSentTime - txStartTime;

          console.log(`📋 Transaction sent: ${sig} (${sendDuration}ms)`);
          console.log('⏳ Confirming transaction...');

          // Add timeout for confirmation
          const confirmationPromise = connection.confirmTransaction(
            { signature: sig, blockhash, lastValidBlockHeight },
            'confirmed'
          );

          let timeoutId: NodeJS.Timeout;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error('Transaction confirmation timeout')),
              30000
            );
          });

          try {
            await Promise.race([confirmationPromise, timeoutPromise]);
            clearTimeout(timeoutId!); // Clear timeout on success
          } catch (error) {
            clearTimeout(timeoutId!); // Clear timeout on error
            throw error;
          }

          const txConfirmedTime = Date.now();
          const confirmationDuration = txConfirmedTime - txSentTime;
          const totalTxDuration = txConfirmedTime - txStartTime;

          // Calculate transaction cost
          const finalBalance = await connection.getBalance(payer.publicKey);
          const totalCostLamports = initialBalance - finalBalance;
          const totalCostSOL = totalCostLamports / LAMPORTS_PER_SOL;

          console.log(`\n✅ Sent: ${sig}`);
          console.log(`🔗 https://solscan.io/tx/${sig}`);

          // Timing information
          console.log('\n⏰ Transaction Timing:');
          console.log(`   📤 Send time: ${sendDuration}ms`);
          console.log(`   ⏳ Confirmation time: ${confirmationDuration}ms`);
          console.log(
            `   🕐 Total transaction time: ${totalTxDuration}ms (${(
              totalTxDuration / 1000
            ).toFixed(2)}s)`
          );

          // Cost breakdown
          console.log('\n💸 Transaction Cost Breakdown:');
          if (side === 'buy') {
            console.log(`   💰 SOL spent on tokens: ${solArg?.toFixed(8)} SOL`);
            console.log(
              `   ⚡ Network fees + Priority fee: ${(
                totalCostSOL - (solArg || 0)
              ).toFixed(8)} SOL`
            );
            console.log(
              `   📊 Total SOL used: ${Math.abs(totalCostSOL).toFixed(8)} SOL`
            );
          } else {
            console.log(
              `   💰 SOL received from tokens: ${quote.out.sol.toFixed(8)} SOL`
            );
            const feesPaid = Math.abs(totalCostSOL) - quote.out.sol;
            console.log(
              `   ⚡ Network fees + Priority fee: ${feesPaid.toFixed(8)} SOL`
            );
            console.log(`   📊 Total fees paid: ${feesPaid.toFixed(8)} SOL`);
          }
          console.log(
            `   🏦 Final balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(
              6
            )} SOL`
          );

          // Clean exit after success
          const processEndTime = Date.now();
          const totalProcessDuration = processEndTime - processStartTime;

          console.log('\n📊 Overall Process Summary:');
          console.log(
            `   ⏱️  Total process duration: ${totalProcessDuration}ms (${(
              totalProcessDuration / 1000
            ).toFixed(2)}s)`
          );
          console.log(
            `   🏃 Transaction portion: ${(
              (totalTxDuration / totalProcessDuration) *
              100
            ).toFixed(1)}% of total time`
          );
          console.log(
            `   🔧 Setup & preparation: ${(
              ((totalProcessDuration - totalTxDuration) /
                totalProcessDuration) *
              100
            ).toFixed(1)}% of total time`
          );

          console.log('\n🏁 Transaction completed successfully!');
          process.exit(0);
        }
      } catch (error: any) {
        console.log(`\n❌ Attempt ${attempt} failed:`);
        console.log(`   Error: ${error.message}`);

        if (error.logs) {
          console.log('   Transaction logs:');
          error.logs.forEach((log: string, i: number) => {
            console.log(`     ${i + 1}. ${log}`);
          });
        }

        if (attempt === retries) {
          console.log(`\n💥 All ${retries} attempts failed. Final error:`);
          throw error; // Re-throw on final attempt
        }

        console.log(
          `🔄 Retrying in 2 seconds... (${retries - attempt} attempts left)`
        );
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
      }
    }
  };

  await buildAndSendTransaction();

  // Ensure clean exit (this shouldn't be reached due to process.exit(0) above, but just in case)
  console.log('🏁 Process completed!');
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ Error:', e?.message || e);
  process.exit(1);
});
