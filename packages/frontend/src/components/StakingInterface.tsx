"use client";

import { useEffect, useState } from "react";
import PayoutCalculator from "./PayoutCalculator";
import GasFeeDisplay from "./GasFeeDisplay";
import NetworkMismatchBanner from "./NetworkMismatchBanner";
import { useWalletContext } from "./WalletContext";
import { signTransactionWithWallet } from "@/lib/walletSigning";
import {
  describeApiError,
  submitStake,
  toStroops,
  type Market,
  type MarketOdds,
} from "@/lib/backend";

interface Props {
  market: Market;
  odds: MarketOdds | null;
  /** Called after the stake transaction has been submitted successfully. */
  onStaked?: () => void | Promise<void>;
}

const MAX_COMMENT = 140;

/** Parse the amount field without ever routing money through a float. */
function parseAmount(amount: string): bigint | null {
  try {
    const stroops = toStroops(amount);
    return stroops > 0n ? stroops : null;
  } catch {
    return null;
  }
}

export default function StakingInterface({ market, odds, onStaked }: Props) {
  const [amount, setAmount] = useState<string>("10");
  const [selectedSide, setSelectedSide] = useState<"YES" | "NO" | null>(null);
  const [isStaking, setIsStaking] = useState(false);
  const [comment, setComment] = useState<string>("");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    isConnected,
    publicKey,
    walletType,
    network,
    networkStatus,
    requireNetworkMatch,
  } = useWalletContext();

  const networkMismatch = networkStatus.status !== "match";

  const amountStroops = parseAmount(amount);
  const marketClosed =
    market.resolved ||
    (market.endTime !== null &&
      new Date(market.endTime).getTime() <= Date.now());
  const canSubmit =
    !!selectedSide &&
    amountStroops !== null &&
    isConnected &&
    !networkMismatch &&
    !marketClosed &&
    !isStaking;

  // A disabled control that does not say why it is disabled leaves the user
  // guessing, and a screen reader announces only "dimmed". The first unmet
  // condition is surfaced, in the order a user would hit them.
  const disabledReason = (() => {
    if (isStaking) return "Your stake is being submitted.";
    if (marketClosed)
      return "This market is closed, so it can no longer be staked on.";
    if (!isConnected) return "Connect a wallet to stake.";
    if (networkMismatch)
      return "Switch your wallet to the correct network to stake.";
    if (!selectedSide) return "Choose an outcome to stake on.";
    if (amountStroops === null) return "Enter a valid stake amount.";
    return null;
  })();

  // Clear cached transaction state whenever the account or network changes so
  // a stale hash/error from a previous wallet cannot linger in the view.
  useEffect(() => {
    setTxHash(null);
    setError(null);
    setIsStaking(false);
  }, [publicKey, network]);

  const handleStake = async () => {
    if (!selectedSide || amountStroops === null || !publicKey) return;
    requireNetworkMatch();

    setIsStaking(true);
    setError(null);
    setTxHash(null);
    try {
      const result = await submitStake({
        callId: market.id,
        userAddress: publicKey,
        side: selectedSide,
        amountStroops,
        ...(comment ? { comment } : {}),
        signTransaction: (xdr) => signTransactionWithWallet(walletType, xdr),
      });
      setTxHash(result.hash);
      setAmount("10");
      setSelectedSide(null);
      setComment("");
      await onStaked?.();
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setIsStaking(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-8 shadow-sm">
      <h3 className="text-xl font-bold text-gray-900 mb-8">Place Your Stake</h3>

      {/* Side selection */}
      <div className="grid grid-cols-2 gap-4 mb-10">
        <button
          onClick={() => setSelectedSide("YES")}
          className={`relative group overflow-hidden py-5 rounded-2xl font-bold transition-all duration-300 ${
            selectedSide === "YES"
              ? "bg-green-600 text-white shadow-xl shadow-green-200 scale-[1.02]"
              : "bg-green-50 text-green-700 hover:bg-green-100 border border-green-100"
          }`}
        >
          <div className="relative z-10 flex flex-col items-center">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-80 mb-2">
              Market YES
            </span>
            <span className="text-3xl font-black">
              {odds ? Number(odds.yes).toFixed(2) : "—"}x
            </span>
          </div>
          {selectedSide === "YES" && (
            <div className="absolute inset-0 bg-gradient-to-tr from-green-600 to-emerald-400 opacity-100" />
          )}
        </button>

        <button
          onClick={() => setSelectedSide("NO")}
          className={`relative group overflow-hidden py-5 rounded-2xl font-bold transition-all duration-300 ${
            selectedSide === "NO"
              ? "bg-red-600 text-white shadow-xl shadow-red-200 scale-[1.02]"
              : "bg-red-50 text-red-700 hover:bg-red-100 border border-red-100"
          }`}
        >
          <div className="relative z-10 flex flex-col items-center">
            <span className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-80 mb-2">
              Market NO
            </span>
            <span className="text-3xl font-black">
              {odds ? Number(odds.no).toFixed(2) : "—"}x
            </span>
          </div>
          {selectedSide === "NO" && (
            <div className="absolute inset-0 bg-gradient-to-tr from-red-600 to-rose-400 opacity-100" />
          )}
        </button>
      </div>

      {/* Amount input & Slider */}
      <div className="mb-10">
        <div className="flex justify-between items-end mb-4">
          <label
            htmlFor="stake-amount"
            className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em]"
          >
            Stake Amount ({market.stakeToken})
          </label>
          <span className="text-3xl font-black text-gray-900 leading-none">
            {amount || "0"}
          </span>
        </div>

        <div className="slider-container relative mb-8 flex items-center h-10">
          <input
            id="stake-amount"
            type="range"
            min="1"
            max="1000"
            step="1"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "stake-error" : undefined}
            className="w-full h-1.5 bg-gray-100 rounded-full appearance-none cursor-pointer accent-indigo-600 hover:accent-indigo-700 transition-all"
          />
        </div>

        <div className="grid grid-cols-4 gap-3">
          {["10", "50", "250", "500"].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setAmount(v)}
              // Without aria-pressed the selected preset is conveyed only by
              // its indigo fill, which is invisible to anyone not seeing colour.
              aria-pressed={amount === v}
              aria-label={`Stake ${v} ${market.stakeToken}`}
              className="py-2.5 text-xs font-bold border border-gray-100 rounded-xl hover:bg-indigo-50 hover:border-indigo-100 hover:text-indigo-600 transition-all text-gray-500 bg-white"
            >
              {v}
            </button>
          ))}
        </div>

        {/* Percentage presets — wired to the live wallet balance in issue #552 */}
        <div className="mt-3 grid grid-cols-4 gap-2">
          {[25, 50, 75, 100].map((pct) => {
            const BALANCE = 1000; // placeholder; replaced by the wallet balance hook (#552)
            const val = Math.floor((BALANCE * pct) / 100);
            const active = amount === String(val);
            return (
              <button
                key={pct}
                type="button"
                onClick={() => setAmount(String(val))}
                aria-pressed={active}
                aria-label={
                  pct === 100
                    ? `Stake maximum, ${val} ${market.stakeToken}`
                    : `Stake ${pct} percent, ${val} ${market.stakeToken}`
                }
                className={`py-2 text-xs font-bold rounded-xl border transition-all ${
                  active
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "border-gray-100 text-gray-500 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-600 bg-white"
                }`}
              >
                {pct === 100 ? "MAX" : `${pct}%`}
              </button>
            );
          })}
        </div>
      </div>

      {/* Payout Calculator */}
      <div className="mb-10">
        <PayoutCalculator
          yesPoolStroops={market.totalYesStroops}
          noPoolStroops={market.totalNoStroops}
          amountStroops={amountStroops}
          side={selectedSide}
          stakeToken={market.stakeToken}
        />
      </div>

      {/* Optional stake comment */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-2">
          <label
            htmlFor="stake-comment"
            className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em]"
          >
            Add a reason (optional)
          </label>
          <span
            className={`text-xs font-medium ${comment.length > MAX_COMMENT - 20 ? "text-red-500" : "text-gray-400"}`}
          >
            {MAX_COMMENT - comment.length}
          </span>
        </div>
        <textarea
          id="stake-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, MAX_COMMENT))}
          placeholder="Share your thesis for this stake..."
          rows={2}
          className="w-full rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700 placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
      </div>

      {error && (
        <p
          id="stake-error"
          role="alert"
          className="mb-4 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2"
        >
          {error}
        </p>
      )}

      {txHash && (
        <p className="mb-4 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 break-all">
          Stake submitted — transaction {txHash}
        </p>
      )}

      <NetworkMismatchBanner />

      {/* Stake button */}
      {/* Announced via aria-describedby rather than a live region: it is a
          static explanation of the button's state, not a change to report. */}
      {disabledReason && (
        <p id="stake-submit-reason" className="sr-only">
          {disabledReason}
        </p>
      )}

      <button
        type="button"
        onClick={handleStake}
        disabled={!canSubmit}
        aria-describedby={disabledReason ? "stake-submit-reason" : undefined}
        className={`w-full py-6 rounded-3xl font-black text-xl shadow-2xl transition-all duration-300 transform active:scale-95 flex items-center justify-center gap-3 ${
          !canSubmit
            ? "bg-gray-100 text-gray-400 cursor-not-allowed shadow-none"
            : selectedSide === "YES"
              ? "bg-green-600 text-white hover:bg-green-700 shadow-green-500/10 hover:shadow-green-500/20"
              : "bg-red-600 text-white hover:bg-red-700 shadow-red-500/10 hover:shadow-red-500/20"
        }`}
      >
        {isStaking ? (
          <>
            <svg
              className="animate-spin h-6 w-6 text-white"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            Processing...
          </>
        ) : (
          `STAKE ON ${selectedSide ?? "…"}`
        )}
      </button>

      {marketClosed && (
        <p className="mt-3 text-xs text-center text-gray-500">
          This market is closed and no longer accepts stakes.
        </p>
      )}
      {!isConnected && !marketClosed && (
        <p className="mt-3 text-xs text-center text-gray-400">
          Connect your wallet to stake
        </p>
      )}
      {isConnected && networkMismatch && !marketClosed && (
        <p className="mt-3 text-xs text-center text-amber-600">
          Switch your wallet to the configured network to stake
        </p>
      )}

      <div className="mt-4 flex justify-center">
        <GasFeeDisplay />
      </div>
    </div>
  );
}
