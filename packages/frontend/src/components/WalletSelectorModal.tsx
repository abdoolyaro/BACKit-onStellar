"use client";

import { Fragment, useRef } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { X } from "lucide-react";
import { WalletType } from "@/hooks/useWallet";
import { useReducedMotion } from "@/hooks/useReducedMotion";

interface WalletOption {
  type: WalletType;
  name: string;
  description: string;
  downloadUrl: string;
  logo: string; // emoji or URL
}

const WALLETS: WalletOption[] = [
  {
    type: "freighter",
    name: "Freighter",
    description: "Browser extension by Stellar Development Foundation",
    downloadUrl: "https://freighter.app",
    logo: "🚀",
  },
  {
    type: "lobstr",
    name: "Lobstr",
    description: "Popular Stellar wallet with browser extension",
    downloadUrl: "https://lobstr.co/extension",
    logo: "🦞",
  },
  {
    type: "albedo",
    name: "Albedo",
    description: "Web-based signer — no install required",
    downloadUrl: "https://albedo.link",
    logo: "✨",
  },
];

interface WalletSelectorModalProps {
  open: boolean;
  onClose: () => void;
  installedWallets: Record<WalletType, boolean> | null;
  onSelect: (walletType: WalletType) => void;
}

export function WalletSelectorModal({
  open,
  onClose,
  installedWallets,
  onSelect,
}: WalletSelectorModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const prefersReducedMotion = useReducedMotion();

  const handleSelect = (wallet: WalletOption) => {
    const installed = installedWallets?.[wallet.type] ?? false;
    if (!installed && wallet.type !== "albedo") {
      window.open(wallet.downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }
    onSelect(wallet.type);
    onClose();
  };

  // Headless UI's Dialog supplies the parts a hand-rolled modal usually misses:
  // role/aria-modal, focus trapping, Escape handling, and focus restoration to
  // the element that opened it. `initialFocus` is set explicitly so focus lands
  // somewhere predictable rather than on whichever node happens to be first.
  const transition = prefersReducedMotion
    ? {
        enter: "",
        enterFrom: "",
        enterTo: "",
        leave: "",
        leaveFrom: "",
        leaveTo: "",
      }
    : {
        enter: "ease-out duration-200",
        enterFrom: "opacity-0",
        enterTo: "opacity-100",
        leave: "ease-in duration-150",
        leaveFrom: "opacity-100",
        leaveTo: "opacity-0",
      };

  return (
    <Transition.Root show={open} as={Fragment}>
      <Dialog
        as="div"
        className="relative z-50"
        onClose={onClose}
        initialFocus={closeButtonRef}
      >
        <Transition.Child as={Fragment} {...transition}>
          <div
            className="fixed inset-0"
            style={{
              background: "rgba(0,0,0,0.7)",
              backdropFilter: "blur(4px)",
            }}
            aria-hidden="true"
          />
        </Transition.Child>

        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Transition.Child as={Fragment} {...transition}>
            <Dialog.Panel
              className="w-full max-w-sm rounded-2xl p-6"
              style={{
                background: "#0d1117",
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow: "0 24px 80px rgba(0,0,0,0.6)",
              }}
            >
              <div className="flex items-center justify-between mb-6">
                <Dialog.Title className="text-lg font-semibold text-white">
                  Connect Wallet
                </Dialog.Title>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={onClose}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                  aria-label="Close wallet selector"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <ul className="flex flex-col gap-3 list-none p-0 m-0">
                {WALLETS.map((wallet) => {
                  const installed = installedWallets?.[wallet.type] ?? false;
                  const available = installed || wallet.type === "albedo";
                  const statusLabel =
                    wallet.type === "albedo"
                      ? "Web"
                      : installed
                        ? "Installed"
                        : "Not Installed";
                  const descriptionId = `wallet-${wallet.type}-description`;

                  return (
                    <li key={wallet.type}>
                      <button
                        type="button"
                        onClick={() => handleSelect(wallet)}
                        aria-describedby={descriptionId}
                        // Screen reader users get the consequence of activating
                        // this, which differs by wallet: an uninstalled wallet
                        // opens a download page in a new tab rather than
                        // connecting.
                        aria-label={
                          available
                            ? `Connect with ${wallet.name}`
                            : `Install ${wallet.name}, opens in a new tab`
                        }
                        className="w-full flex items-center gap-4 p-4 rounded-xl text-left transition-all hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                        style={{ border: "1px solid rgba(255,255,255,0.07)" }}
                      >
                        <span
                          className="text-2xl w-10 text-center"
                          aria-hidden="true"
                        >
                          {wallet.logo}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-white">
                            {wallet.name}
                          </span>
                          <span
                            id={descriptionId}
                            className="block text-xs text-gray-500 truncate"
                          >
                            {wallet.description}
                          </span>
                        </span>
                        {/* Status is carried by the text itself, not the badge
                            colour, so it survives for anyone who cannot
                            distinguish the green and grey treatments. */}
                        <span
                          className="text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0"
                          style={
                            available
                              ? {
                                  background: "rgba(34,197,94,0.12)",
                                  color: "#22c55e",
                                }
                              : {
                                  background: "rgba(107,114,128,0.15)",
                                  color: "#6b7280",
                                }
                          }
                        >
                          {statusLabel}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <Dialog.Description className="text-xs text-gray-600 text-center mt-5">
                By connecting, you agree to sign a message to authenticate.
              </Dialog.Description>
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
