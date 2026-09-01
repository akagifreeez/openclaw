import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import { afterEach, describe, expect, it } from "vitest";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "@awesome.me/webawesome/dist/components/popover/popover.js";
import "./web-awesome.ts";
import "./tooltip.ts";

const browserMode = "__vitest_browser__" in globalThis;

async function fixture(initialOpen = false) {
  const host = document.createElement("div");
  host.innerHTML = `<wa-dropdown ${initialOpen ? "open" : ""}>
    <button slot="trigger">Actions</button>
    <wa-dropdown-item type="checkbox" value="search">Web search</wa-dropdown-item>
    <wa-dropdown-item>More<wa-dropdown-item slot="submenu" value="nested">Nested action</wa-dropdown-item></wa-dropdown-item>
  </wa-dropdown><button data-outside>Outside</button>`;
  const dropdown = host.querySelector("wa-dropdown")!;
  const trigger = host.querySelector("button")!;
  const outside = host.querySelector<HTMLButtonElement>("[data-outside]")!;
  const item = host.querySelector("wa-dropdown-item")!;
  const parent = host.querySelectorAll("wa-dropdown-item")[1];
  const nested = host.querySelectorAll("wa-dropdown-item")[2];
  if (!parent || !nested) {
    throw new Error("Dropdown fixture requires a submenu parent and nested item");
  }
  const events: { type: string; open: boolean; connected: boolean }[] = [];
  for (const type of ["wa-show", "wa-hide", "wa-after-show", "wa-after-hide"]) {
    dropdown.addEventListener(type, (event) => {
      if (event.target === dropdown) {
        events.push({ type, open: dropdown.open, connected: dropdown.isConnected });
      }
    });
  }
  document.body.append(host);
  await dropdown.updateComplete;
  await Promise.all([item.updateComplete, parent.updateComplete, nested.updateComplete]);
  const menu = dropdown.shadowRoot!.querySelector<HTMLElement>('[part="menu"]')!;
  const popup = dropdown.shadowRoot!.querySelector("wa-popup")!;
  return { host, dropdown, trigger, outside, item, parent, nested, menu, popup, events };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const frame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
const count = (f: Fixture, type: string) => f.events.filter((event) => event.type === type).length;

async function open(f: Fixture) {
  const before = count(f, "wa-after-show");
  f.dropdown.open = true;
  await expect.poll(() => count(f, "wa-after-show")).toBe(before + 1);
}

// Run in the animation-start task, not after a host RPC that can outlast the animation.
async function duringAnimation(f: Fixture, state: "show" | "hide", action: () => void) {
  let observed = false;
  const listener = (event: AnimationEvent) => {
    if (event.target !== f.menu || !f.menu.classList.contains(state)) {
      return;
    }
    f.menu.removeEventListener("animationstart", listener);
    expect(f.menu.getAnimations().some((animation) => animation.playState === "running")).toBe(
      true,
    );
    observed = true;
    action();
  };
  f.menu.addEventListener("animationstart", listener);
  f.dropdown.open = state === "show";
  try {
    await expect.poll(() => observed).toBe(true);
  } finally {
    f.menu.removeEventListener("animationstart", listener);
  }
}

async function reopen(f: Fixture) {
  await open(f);
  await duringAnimation(f, "hide", () => {
    f.dropdown.open = true;
  });
  await expect.poll(() => count(f, "wa-after-show")).toBe(2);
  expect(count(f, "wa-after-hide")).toBe(0);
  expect(f.dropdown.open).toBe(true);
}

async function closed(f: Fixture) {
  await expect.poll(() => f.popup.active).toBe(false);
  expect(f.dropdown.open).toBe(false);
  expect(f.menu.getAnimations()).toHaveLength(0);
  expect(f.events.filter((event) => event.type === "wa-after-hide")).toEqual([
    { type: "wa-after-hide", open: false, connected: true },
  ]);
}

afterEach(() => document.body.replaceChildren());

describe.runIf(browserMode)("Web Awesome dropdown lifecycle", () => {
  it.each(["Escape", "pointer", "Tab"] as const)(
    "reacquires %s dismissal after an observed hide/reopen",
    async (dismissal) => {
      const { page, userEvent } = await import("vitest/browser");
      const f = await fixture();
      f.dropdown.addEventListener("wa-select", (event) => event.preventDefault());
      await reopen(f);
      await page.elementLocator(f.item).click();
      expect(f.item.checked).toBe(true);
      expect(f.dropdown.open).toBe(true);
      expect(document.querySelector("openclaw-tooltip[open]")).toBeNull();
      if (dismissal === "pointer") {
        await page.elementLocator(f.outside).click();
      } else {
        await userEvent.keyboard(`{${dismissal}}`);
      }
      await closed(f);
      expect(document.activeElement).toBe(dismissal === "Escape" ? f.trigger : f.outside);
      await page.elementLocator(f.outside).hover();
      f.outside.focus();
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(f.outside);
    },
  );

  it("dismisses a real tooltip first without changing menu selection or focus", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture();
    await reopen(f);
    f.item.checked = true;
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "Search the web for current information";
    tooltip.anchor = f.item;
    f.host.append(tooltip);
    await tooltip.updateComplete;
    f.outside.focus();
    f.item.focus();
    const hint = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
    await expect.poll(() => hint.open).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => hint.open).toBe(false);
    expect(f.dropdown.open).toBe(true);
    expect(f.item.checked).toBe(true);
    expect(document.activeElement).toBe(f.item);
    expect(count(f, "wa-after-hide")).toBe(0);
    await userEvent.keyboard("{Escape}");
    await closed(f);
    expect(document.activeElement).toBe(f.trigger);
  });

  it.each(["before frame", "running", "zero duration"] as const)(
    "settles rapid reversals without stale focus or completion (%s)",
    async (timing) => {
      const f = await fixture();
      if (timing === "zero duration") {
        f.dropdown.style.setProperty("--show-duration", "0ms");
        f.dropdown.style.setProperty("--hide-duration", "0ms");
      }
      if (timing === "running") {
        await duringAnimation(f, "show", () => {
          f.dropdown.open = false;
          f.outside.focus();
        });
      } else {
        f.dropdown.open = true;
        await f.dropdown.updateComplete;
        f.dropdown.open = false;
        f.outside.focus();
      }
      await closed(f);
      expect(count(f, "wa-after-show")).toBe(0);
      expect(document.activeElement).toBe(f.outside);
      await open(f);
      expect(document.activeElement).toBe(f.item);
    },
  );

  it("keeps a canceled show closed and a subsequent accepted show functional", async () => {
    const f = await fixture();
    f.dropdown.addEventListener("wa-show", (event) => event.preventDefault(), { once: true });
    f.dropdown.open = true;
    await expect.poll(() => f.dropdown.open).toBe(false);
    await frame();
    expect(f.popup.active).toBe(false);
    expect(count(f, "wa-after-show")).toBe(0);
    await open(f);
  });

  it("preserves an active show when hide is canceled", async () => {
    const f = await fixture();
    f.dropdown.addEventListener("wa-hide", (event) => event.preventDefault(), { once: true });
    await duringAnimation(f, "show", () => {
      f.dropdown.open = false;
    });
    await expect.poll(() => count(f, "wa-after-show")).toBe(1);
    expect(f.dropdown.open).toBe(true);
    expect(count(f, "wa-after-hide")).toBe(0);
  });

  it("retains dismissal stack order when a hide is canceled below a popover", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture();
    await open(f);
    const popover = document.createElement("wa-popover");
    popover.textContent = "Additional details";
    popover.anchor = f.item;
    f.host.append(popover);
    await popover.updateComplete;
    popover.open = true;
    await expect.poll(() => popover.open).toBe(true);
    await popover.updateComplete;
    f.dropdown.addEventListener("wa-hide", (event) => event.preventDefault(), { once: true });
    f.dropdown.open = false;
    await expect.poll(() => f.dropdown.open).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => popover.open).toBe(false);
    expect(f.dropdown.open).toBe(true);
    await userEvent.keyboard("{Escape}");
    await closed(f);
  });

  it.each([
    { dir: "ltr", openKey: "ArrowRight" },
    { dir: "rtl", openKey: "ArrowLeft" },
    { dir: "ltr", openKey: "Enter" },
    { dir: "rtl", openKey: "Enter" },
  ])(
    "preserves canceled-hide submenus and $dir navigation via $openKey",
    async ({ dir, openKey }) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      f.dropdown.dir = dir;
      await open(f);
      await userEvent.keyboard("{ArrowDown}");
      await userEvent.keyboard(`{${openKey}}`);
      await expect.poll(() => document.activeElement).toBe(f.nested);
      f.dropdown.addEventListener("wa-hide", (event) => event.preventDefault(), { once: true });
      f.dropdown.open = false;
      await expect.poll(() => f.dropdown.open).toBe(true);
      expect(f.parent.submenuOpen).toBe(true);
      await userEvent.keyboard(dir === "rtl" ? "{ArrowRight}" : "{ArrowLeft}");
      await expect.poll(() => document.activeElement).toBe(f.parent);
      expect(f.parent.submenuOpen).toBe(false);
      await userEvent.keyboard(`{${openKey}}`);
      await expect.poll(() => document.activeElement).toBe(f.nested);
      const selected: Element[] = [];
      f.dropdown.addEventListener("wa-select", (event: WaSelectEvent) =>
        selected.push(event.detail.item),
      );
      await userEvent.keyboard("{Enter}");
      await closed(f);
      expect(selected).toHaveLength(1);
      expect(selected[0]).toBe(f.nested);
    },
  );

  it.each(["show", "hide", "reopen"] as const)(
    "cleans up an interrupted %s across disconnect and remount",
    async (phase) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      if (phase !== "show") {
        await open(f);
      }
      const disconnect = () =>
        requestAnimationFrame(() => {
          expect(
            f.menu.getAnimations().some((animation) => animation.playState === "running"),
          ).toBe(true);
          if (phase === "reopen") {
            f.dropdown.open = true;
          }
          f.dropdown.remove();
        });
      await duringAnimation(f, phase === "show" ? "show" : "hide", disconnect);
      await expect.poll(() => f.dropdown.isConnected).toBe(false);
      const completions = f.events.filter((event) => event.type.startsWith("wa-after"));
      f.outside.focus();
      await frame();
      await frame();
      await userEvent.keyboard("{ArrowDown}");
      expect(document.activeElement).toBe(f.outside);
      expect(f.events.filter((event) => event.type.startsWith("wa-after"))).toEqual(completions);
      const sibling = await fixture();
      await open(sibling);
      expect(f.dropdown.open).toBe(phase !== "hide");
      await userEvent.keyboard("{Escape}");
      await closed(sibling);
      const before = count(f, "wa-after-show");
      f.dropdown.open = true;
      f.host.prepend(f.dropdown);
      await expect.poll(() => count(f, "wa-after-show")).toBe(before + 1);
      expect(document.activeElement).toBe(f.item);
      await userEvent.keyboard("{Escape}");
      await closed(f);
    },
  );

  it("registers an initially open dropdown after client upgrade", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture(true);
    await expect.poll(() => count(f, "wa-after-show")).toBe(1);
    await userEvent.keyboard("{Escape}");
    await closed(f);
    expect(document.activeElement).toBe(f.trigger);
  });
});
