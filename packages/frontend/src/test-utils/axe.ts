import axe, { type AxeResults, type RunOptions } from "axe-core";

/**
 * Run axe against a container and return any violations.
 *
 * Scoped to the rendered container rather than the whole document, so one
 * component's result is not polluted by another test's leftovers.
 *
 * `color-contrast` is disabled here because jsdom does not compute layout or
 * resolve CSS, so axe cannot measure contrast and would report false results
 * either way. Contrast is verified separately — see
 * `docs/accessibility/wcag-audit.md`.
 */
export async function findAccessibilityViolations(
  container: Element,
  options: RunOptions = {},
): Promise<AxeResults["violations"]> {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
    ...options,
  });
  return results.violations;
}

/** Format violations into something readable in a test failure. */
export function formatViolations(violations: AxeResults["violations"]): string {
  return violations
    .map((v) => {
      const nodes = v.nodes.map((n) => `      ${n.html}`).join("\n");
      return `  [${v.impact ?? "unknown"}] ${v.id}: ${v.help}\n${nodes}`;
    })
    .join("\n");
}

/** Assert a container has no axe violations, reporting them all if it does. */
export async function expectNoAccessibilityViolations(
  container: Element,
  options?: RunOptions,
): Promise<void> {
  const violations = await findAccessibilityViolations(container, options);
  if (violations.length > 0) {
    throw new Error(
      `Expected no accessibility violations, found ${violations.length}:\n${formatViolations(violations)}`,
    );
  }
}
