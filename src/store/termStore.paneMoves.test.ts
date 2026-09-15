//! Store-level behaviour of placing existing sessions into panes: moves commit in one update and never end a
//! process, a displaced named session survives in the background under the live-tab limit, and the actions fall
//! back to plain opening when there is no pane to place into.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/commands", () => ({
  createWorktree: vi.fn(),
  getSessionCwd: vi.fn().mockResolvedValue(null),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  listShells: vi.fn().mockResolvedValue([]),
}));
vi.mock("../ipc/tree", () => ({ listTree: vi.fn() }));
vi.mock("../notify", () => ({ notify: vi.fn() }));
vi.mock("../ipc/transport", () => ({ isTauri: true, invokeNative: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../platform", () => {
  const env = {
    kind: "tauri",
    isTauri: true,
    isElectron: false,
    isBrowser: false,
    isRemoteWindow: false,
    hasNativeHost: true,
    isMac: false,
  };
  return { env, platform: { env, dialog: { pickDirectory: vi.fn(), saveFile: vi.fn() } } };
});

import { ptyKill } from "../ipc/commands";
import { collectSessionIds, findBySession } from "../layout/CenterPane/paneTree";
import type { Session } from "../types";
import { useTermStore } from "./termStore";

function mkSession(id: string): Session {
  return {
    id,
    projectId: "p1",
    groupId: null,
    name: id,
    kind: "claude",
    shell: null,
    cwd: "/tmp",
    envJson: null,
    initCmd: null,
    hotkey: null,
    parentSessionId: null,
    collapsed: false,
    worktreePath: null,
    sortOrder: 0,
    createdAt: 0,
  };
}

function seed(ids: string[]) {
  useTermStore.setState({
    projects: [
      { id: "p1", name: "P", rootPath: "/tmp", color: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ],
    groups: [],
    sessions: ids.map(mkSession),
    runtimes: Object.fromEntries(ids.map((id) => [id, { status: "idle" as const }])),
    epochs: {},
    ephemeralSessions: {},
    dormantSessions: {},
    pendingPrompts: {},
    openTabs: [],
    pinnedTabs: [],
    activeTabId: null,
    lastActiveSessionTabId: null,
    paneTrees: {},
    activeSessionId: null,
    focusedPaneId: null,
    liveTabs: [],
    docTabs: {},
    browserTabs: {},
    notifications: {},
    liveEvictNotice: null,
    liveEvictAsk: false,
    maxLiveTabs: 32,
    singleTabMode: true,
  });
}

/** Tab ID showing each session, across visible and background tabs. */
function shownIn(): Record<string, string> {
  const s = useTermStore.getState();
  const out: Record<string, string> = {};
  for (const tabId of [...s.openTabs, ...s.liveTabs]) {
    for (const sid of collectSessionIds(s.paneTrees[tabId])) out[sid] = tabId;
  }
  return out;
}

beforeEach(() => {
  vi.mocked(ptyKill).mockClear();
});

afterEach(() => {
  localStorage.clear();
});

describe("openSessionInSplit", () => {
  it("moves a session from a background tab next to the focused pane without ending it", () => {
    seed(["A", "B"]);
    const st = useTermStore.getState();
    st.openSession("B");
    st.openSession("A"); // Single-tab mode sends B's tab to the background.
    expect(useTermStore.getState().liveTabs).toEqual(["B"]);

    useTermStore.getState().openSessionInSplit("B", "horizontal", { source: "sidebar" });

    const s = useTermStore.getState();
    expect(s.liveTabs).toEqual([]);
    expect(shownIn()).toEqual({ A: "A", B: "A" });
    expect(s.activeSessionId).toBe("B");
    expect(s.focusedPaneId).toBe(findBySession(s.paneTrees.A, "B")?.paneId);
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it("opens a new tab when the active tab has no panes", () => {
    seed(["A"]);
    useTermStore.getState().openSessionInSplit("A", "vertical");
    const s = useTermStore.getState();
    expect(s.openTabs).toEqual(["A"]);
    expect(s.pinnedTabs).toEqual(["A"]);
  });

  it("wakes a dormant session it places", () => {
    seed(["A", "B"]);
    useTermStore.getState().openSession("A");
    useTermStore.setState({ dormantSessions: { B: true } });
    useTermStore.getState().openSessionInSplit("B", "horizontal");
    const s = useTermStore.getState();
    expect(s.dormantSessions).toEqual({});
    expect(s.epochs.B).toBe(1);
  });
});

describe("openSessionInPane", () => {
  it("keeps the displaced named session alive in a background tab", () => {
    seed(["A", "B"]);
    const st = useTermStore.getState();
    st.openSession("A", { newTab: true });
    st.openSession("B", { newTab: true });
    st.setActiveTab("A");

    useTermStore.getState().openSessionInPane("B");

    const s = useTermStore.getState();
    expect(s.openTabs).toEqual(["B"]);
    expect(s.liveTabs).toEqual(["A"]);
    expect(shownIn()).toEqual({ A: "A", B: "B" });
    expect(s.activeTabId).toBe("B");
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it("applies live-tab eviction to the displaced session's tab", () => {
    seed(["A", "B", "C"]);
    const st = useTermStore.getState();
    st.openSession("C");
    st.openSession("B"); // C goes to the background.
    useTermStore.setState({ maxLiveTabs: 1 });
    useTermStore.getState().openSessionInPane("A"); // B joins the background, over the limit of one.

    const s = useTermStore.getState();
    expect(s.liveTabs).toEqual(["B"]);
    expect(s.liveEvictNotice?.label).toBe("C");
    expect(shownIn()).toEqual({ A: "A", B: "B" });
  });
});

describe("tileSessions", () => {
  it("tiles sessions from several tabs into one pinned 2×2 tab", () => {
    seed(["A", "B", "C", "D"]);
    const st = useTermStore.getState();
    for (const id of ["A", "B", "C", "D"]) st.openSession(id, { newTab: true });

    useTermStore.getState().tileSessions(["A", "B", "C", "D"]);

    const s = useTermStore.getState();
    expect(s.openTabs).toEqual(["A"]);
    expect(s.pinnedTabs).toEqual(["A"]);
    expect(collectSessionIds(s.paneTrees.A)).toEqual(["A", "C", "B", "D"]);
    expect(s.activeTabId).toBe("A");
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it("skips browser nodes and opens a single remaining session normally", () => {
    seed(["A", "W"]);
    useTermStore.setState({
      sessions: [mkSession("A"), { ...mkSession("W"), kind: "browser" }],
    });
    useTermStore.getState().tileSessions(["A", "W"]);
    const s = useTermStore.getState();
    expect(s.openTabs).toEqual(["A"]);
    expect(collectSessionIds(s.paneTrees.A)).toEqual(["A"]);
  });
});
