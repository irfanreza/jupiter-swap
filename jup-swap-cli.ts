import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import dotenv from "dotenv";
import bs58 from "bs58";
import { executeSwap, type SwapOptions } from "./jup-swap-core";

dotenv.config();

// -----------------------------
// CLI Argument Parsing
// -----------------------------

type Direction = "buy" | "sell";
type AmountIn = "sol" | "token";
type PriorityMode = "compute" | "jito";

interface ParsedArgs {
  rpc?: string;
  keypairPath?: string;
  direction: Direction;
  mint: string;
  amountRaw: string;
  amountIn: AmountIn;
  slippagePct?: number;
  dynamicSlippage?: boolean;
  priorityFeeSol?: number;
  autoPriorityFee?: boolean;
  priorityMode: PriorityMode;
  disableReferralFee: boolean;
  platformFeeBps?: number;
  feeAccount?: string;
  extraFeeSol?: number;
  extraFeeRecipient?: string;
  simulate: boolean;
}

function showHelpAndExit(): never {
  console.log(`
Jupiter Swap CLI

Required:
  --direction <buy|sell>            Swap direction (buy = SOL -> token, sell = token -> SOL)
  --mint <TOKEN_MINT>               Token mint (paired with SOL)
  --amount <NUM|PCT%>               Amount (e.g. 0.5 or 25%)
  --amount-in <sol|token>           Which side your amount refers to (input or output side)

Slippage (choose one):
  --slippage <PERCENT>              Manually set slippage in percent (e.g. 0.5).
  --dynamic-slippage                Enable Jupiter's dynamic slippage calculation.

Configuration (provide via .env file or command line):
  --rpc <URL>                       RPC endpoint (or use RPC_URL in .env)
  --keypair <PATH>                  Path to keypair JSON (or use PRIVATE_KEY in .env)

Priority Fee (optional, choose one):
  --priority-fee <SOL>              Manually set priority fee in SOL.
  --auto-priority-fee               Enable Jupiter's dynamic priority fee estimation.
  --priority-mode <compute|jito>    Fee mode (default: compute).

Platform/referral fee (optional):
  --disable-referral-fee <bool>     true to disable, false to enable (default true)
  --platform-fee-bps <INT>          Basis points (e.g. 20 = 0.2%) to include in quote
  --fee-account <PUBKEY>            Token account to receive the platform fee (must match mint rules)

Extra separate transfer (optional):
  --fee <SOL>                       Extra SOL to transfer to a recipient (separate from Jupiter fees)
  --fee-recipient <PUBKEY>          Recipient of the extra SOL transfer

Simulation:
  --simulate <bool>                 true to only simulate the transaction (no broadcast). Default false.

Examples:
  bun run jup-swap-cli.ts --direction buy --mint <MINT> --amount 0.1 --amount-in sol --dynamic-slippage --auto-priority-fee
`);
  process.exit(1);
}

function parseArgs(argv: string[]): ParsedArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);

  if (has("--help")) showHelpAndExit();

  const direction = get("--direction") as Direction | undefined;
  const mint = get("--mint");
  const amountRaw = get("--amount");
  const amountIn = get("--amount-in") as AmountIn | undefined;
  const slippagePct = get("--slippage");
  const dynamicSlippage = has("--dynamic-slippage");

  if (!direction || !mint || !amountRaw || !amountIn) {
    console.error("Missing required arguments: --direction, --mint, --amount, --amount-in");
    showHelpAndExit();
  }
  if (!slippagePct && !dynamicSlippage) {
    console.error("Missing slippage argument. Use --slippage <PCT> or --dynamic-slippage.");
    showHelpAndExit();
  }
  if (!["buy", "sell"].includes(direction)) showHelpAndExit();
  if (!["sol", "token"].includes(amountIn)) showHelpAndExit();

  return {
    rpc: get("--rpc"),
    keypairPath: get("--keypair"),
    direction,
    mint: mint!,
    amountRaw: amountRaw!,
    amountIn: amountIn!,
    slippagePct: slippagePct ? Number(slippagePct) : undefined,
    dynamicSlippage,
    autoPriorityFee: has("--auto-priority-fee"),
    priorityMode: (get("--priority-mode") as PriorityMode) || "compute",
    disableReferralFee: (get("--disable-referral-fee") ?? "true") === "true",
    simulate: (get("--simulate") ?? "true") === "true",
    priorityFeeSol: get("--priority-fee") ? Number(get("--priority-fee")) : undefined,
    platformFeeBps: get("--platform-fee-bps") ? Number(get("--platform-fee-bps")) : undefined,
    feeAccount: get("--fee-account"),
    extraFeeSol: get("--fee") ? Number(get("--fee")) : undefined,
    extraFeeRecipient: get("--fee-recipient"),
  };
}

// -----------------------------
// Keypair Loading
// -----------------------------

function loadKeypairFromFile(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  const u8 = Uint8Array.from(secret);
  return Keypair.fromSecretKey(u8);
}

function loadKeypairFromPrivateKey(pk: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(pk));
}

// -----------------------------
// Main Execution
// -----------------------------

(async () => {
  try {
    const args = parseArgs(process.argv.slice(2));

    const rpcUrl = args.rpc || process.env.RPC_URL;
    if (!rpcUrl) {
      throw new Error("RPC URL must be provided via --rpc flag or RPC_URL env var in .env file");
    }

    let wallet: Keypair;
    if (args.keypairPath) {
      wallet = loadKeypairFromFile(args.keypairPath);
    } else if (process.env.PRIVATE_KEY) {
      wallet = loadKeypairFromPrivateKey(process.env.PRIVATE_KEY);
    } else {
      throw new Error("Keypair must be provided via --keypair flag or PRIVATE_KEY env var in .env file");
    }

    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

    const onProgress = (log: string) => {
      console.log(log);
    };

    const options: SwapOptions = {
      ...args,
      rpcUrl,
      wallet,
      mint: new PublicKey(args.mint),
      onProgress,
    };

    const result = await executeSwap(options);

    if (result.error) {
      console.error("\nError:", result.error);
      if (result.simulationLogs) {
        console.log("\nLogs:");
        for (const l of result.simulationLogs) console.log(" ", l);
      }
    } else if (result.signature) {
      console.log(`
✅ Success!`);
      console.log(`  Transaction Signature: https://solscan.io/tx/${result.signature}`);
      console.log(`  Execution Time: ${result.executionTimeMs?.toFixed(2)} ms`);

      const inputAmount = Number(result.quoteResponse.inAmount) / (10 ** result.inputDecimals);
      const expectedOutputAmount = Number(result.quoteResponse.outAmount) / (10 ** result.outputDecimals);

      if (result.actualOutAmountAtomic) {
        const actualOutputAmount = Number(BigInt(result.actualOutAmountAtomic)) / (10 ** result.outputDecimals);
        const difference = actualOutputAmount - expectedOutputAmount;
        const differencePct = (difference / expectedOutputAmount) * 100;

        console.log(`
  Expected Out: ${expectedOutputAmount.toFixed(result.outputDecimals)}`);
        console.log(`  Actual Out:   ${actualOutputAmount.toFixed(result.outputDecimals)}`);
        console.log(`  Difference:   ${difference.toFixed(result.outputDecimals)} (${differencePct.toFixed(4)}%)`);

        if (options.direction === "buy") {
            console.log(`
  Price (based on actual): 1 ${options.mint.toBase58()} ≈ ${(inputAmount / actualOutputAmount).toFixed(10)} SOL`);
        } else { // sell
            console.log(`
  Price (based on actual): 1 ${options.mint.toBase58()} ≈ ${(actualOutputAmount / inputAmount).toFixed(10)} SOL`);
        }

      } else {
        // Fallback to old logic if actual amount isn't available
        if (options.direction === "buy") {
            console.log(`  Expected to get: ${expectedOutputAmount.toFixed(result.outputDecimals)} ${options.mint.toBase58()}`);
            console.log(`  Price (based on expected): 1 ${options.mint.toBase58()} ≈ ${(inputAmount / expectedOutputAmount).toFixed(10)} SOL`);
        } else { // sell
            console.log(`  Expected to get: ${expectedOutputAmount.toFixed(result.outputDecimals)} SOL`);
            console.log(`  Price (based on expected): 1 ${options.mint.toBase58()} ≈ ${(expectedOutputAmount / inputAmount).toFixed(10)} SOL`);
        }
      }

      console.log(`
  Actual Network Fee Paid: ${result.fees.networkFeeSol.toFixed(10)} SOL`);
      if (result.fees.priorityFeeSol > 0) {
        console.log(`  Note: Actual priority fee is hard to determine post-facto, but was estimated at ${result.fees.priorityFeeSol.toFixed(10)} SOL.`);
      }

    } else {
      console.log("\n--- SIMULATION SUMMARY ---");
      const { quoteResponse, fees, unitsConsumed } = result;
      console.log("Quote OK:");
      console.log(
        `  in: ${quoteResponse.inAmount} (${quoteResponse.inputMint})  out: ${quoteResponse.outAmount} (${quoteResponse.outputMint})`
      );
      const usedSlippageBps = quoteResponse.slippageBps;
      const usedSlippagePct = usedSlippageBps / 100;
      console.log(`  Slippage: ${usedSlippagePct}% ${options.dynamicSlippage ? "(dynamic)" : "(manual)"}`);
      if (quoteResponse.priceImpactPct) {
        console.log(`  priceImpactPct: ${quoteResponse.priceImpactPct}`);
      }

      const inputAmount = Number(quoteResponse.inAmount) / 10 ** result.inputDecimals;
      const outputAmount = Number(quoteResponse.outAmount) / 10 ** result.outputDecimals;
      const priceOfTokenInSol = inputAmount / outputAmount;
      console.log(`
Estimated Price:`)
      console.log(`  1 Token ≈ ${priceOfTokenInSol.toFixed(10)} SOL`);

      console.log(`
Estimated Fees:`)
      console.log(`  Network Fee: ${fees.networkFeeSol.toFixed(10)} SOL`);
      console.log(`  Priority Fee: ${fees.priorityFeeSol.toFixed(10)} SOL ${options.autoPriorityFee ? "(dynamic)" : "(manual)"}`);
      console.log(`  Total Fee: ~${fees.totalFeeSol.toFixed(10)} SOL`);
      console.log(`unitsConsumed: ${unitsConsumed}`);
      console.log("\n(No transaction was sent due to --simulate=true)");
    }
  } catch (error: any) {
    console.error("\nError:", error.message || error);
    process.exit(1);
  }
})();
