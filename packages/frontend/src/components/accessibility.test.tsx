import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectNoAccessibilityViolations } from "@/test-utils/axe";
import { WalletSelectorModal } from "./WalletSelectorModal";
import CountdownTimer from "./CountdownTimer";
import { TransactionToasts } from "./TransactionToast";

/**
 * WCAG 2.2 AA coverage for the core market and staking journey (#569).
 *
 * These assert the behaviours a keyboard or screen-reader user depends on:
 * focus management in dialogs, programmatically exposed state, correctly
 * scoped live regions, and information that does not rely on colour.
 */

const installed = { freighter: true, lobstr: false, albedo: false } as never;

describe("WalletSelectorModal", () => {
  it("has no automatically detectable accessibility violations", async () => {
    const { container } = render(
      <WalletSelectorModal
        open
        onClose={() => {}}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("exposes itself as a modal dialog with an accessible name", async () => {
    render(
      <WalletSelectorModal
        open
        onClose={() => {}}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Connect Wallet");
  });

  it("moves initial focus into the dialog rather than leaving it on the page", async () => {
    render(
      <WalletSelectorModal
        open
        onClose={() => {}}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    const close = await screen.findByRole("button", {
      name: /close wallet selector/i,
    });
    expect(close).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <WalletSelectorModal
        open
        onClose={onClose}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("traps focus inside the dialog when tabbing", async () => {
    const user = userEvent.setup();
    render(
      <WalletSelectorModal
        open
        onClose={() => {}}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");

    // Tab well past the number of focusable elements; focus must never escape.
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("says what activating an uninstalled wallet will do", async () => {
    render(
      <WalletSelectorModal
        open
        onClose={() => {}}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    // Lobstr is not installed, so the control installs rather than connects.
    expect(
      await screen.findByRole("button", {
        name: /install lobstr, opens in a new tab/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /connect with freighter/i }),
    ).toBeInTheDocument();
  });

  it("conveys install status in text, not colour alone", async () => {
    render(
      <WalletSelectorModal
        open
        onClose={() => {}}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Installed")).toBeInTheDocument();
    expect(within(dialog).getByText("Not Installed")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <WalletSelectorModal
        open={false}
        onClose={() => {}}
        installedWallets={installed}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("TransactionToasts", () => {
  const toast = (
    status: "pending" | "confirming" | "confirmed" | "failed",
  ) => ({
    id: `t-${status}`,
    status,
    message: "Staking 100 XLM",
  });

  it("has no automatically detectable accessibility violations", async () => {
    const { container } = render(
      <TransactionToasts toasts={[toast("pending")]} remove={() => {}} />,
    );
    await expectNoAccessibilityViolations(container);
  });

  it("announces progress politely", () => {
    render(
      <TransactionToasts toasts={[toast("confirming")]} remove={() => {}} />,
    );
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent(/transaction confirming/i);
  });

  it("announces a failure assertively, since it interrupts a pending action", () => {
    render(<TransactionToasts toasts={[toast("failed")]} remove={() => {}} />);
    const live = screen.getByRole("alert");
    expect(live).toHaveAttribute("aria-live", "assertive");
    expect(live).toHaveTextContent(/transaction failed/i);
  });

  it("does not nest live regions, which would announce each change twice", () => {
    render(
      <TransactionToasts toasts={[toast("confirmed")]} remove={() => {}} />,
    );
    const region = screen.getByRole("region", {
      name: /transaction notifications/i,
    });
    expect(region).not.toHaveAttribute("aria-live");
  });

  it("keeps the dismiss control reachable rather than hiding it with the visuals", () => {
    render(<TransactionToasts toasts={[toast("failed")]} remove={() => {}} />);
    expect(
      screen.getByRole("button", { name: /dismiss transaction failure/i }),
    ).toBeInTheDocument();
  });
});

describe("CountdownTimer", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const inMinutes = (m: number) =>
    new Date(Date.now() + m * 60_000).toISOString();

  it("has no automatically detectable accessibility violations", async () => {
    const { container } = render(<CountdownTimer endTime={inMinutes(30)} />);
    await expectNoAccessibilityViolations(container);
  });

  it("does not announce every tick", () => {
    render(<CountdownTimer endTime={inMinutes(30)} />);
    const timer = screen.getByRole("timer");
    // A ticking value with aria-live enabled would talk over everything else.
    expect(timer).toHaveAttribute("aria-live", "off");
  });

  it("keeps updating visually while staying silent", () => {
    render(<CountdownTimer endTime={inMinutes(30)} />);
    const before = screen.getByRole("timer").textContent;

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.getByRole("timer").textContent).not.toBe(before);
    expect(screen.getByRole("timer")).toHaveAttribute("aria-live", "off");
  });

  it("states urgency in words, not only in colour", () => {
    render(<CountdownTimer endTime={inMinutes(30)} />);
    expect(screen.getByRole("timer")).toHaveTextContent(/ending soon/i);
  });

  it("marks a finished market as ended", () => {
    render(
      <CountdownTimer endTime={new Date(Date.now() - 1000).toISOString()} />,
    );
    expect(screen.getByRole("timer")).toHaveTextContent(/ended/i);
  });
});
