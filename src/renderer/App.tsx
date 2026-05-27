import { useEffect, useRef, useState } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { CommandsPage } from "./pages/Commands";
import { SessionsPage } from "./pages/Sessions";
import { PromptsPage } from "./pages/Prompts";
import { Live } from "./pages/Live";
import { TmuxControlDebug } from "./pages/TmuxControlDebug";
import { TmuxTree } from "./components/TmuxTree";
import { CommandBar } from "./components/CommandBar";
import { LaunchToolDialog } from "./components/LaunchToolDialog";
import { initCommandSubscription } from "./store/command";
import { initLaunchSubscription } from "./store/launches";
import { initProxySubscription } from "./store/proxy";
import { usePaneKeymapListener } from "./lib/use-pane-keymap";

function TopTab({ to, children }: { to: string; children: React.ReactNode }) {
  const location = useLocation();
  const active = location.pathname.startsWith(to);

  return (
    <Link
      to={to}
      className={`flex-1 border-b-2 py-2 text-center text-xs font-medium tracking-wide transition-colors ${
        active
          ? "border-neutral-400 text-neutral-200"
          : "border-transparent text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {children}
    </Link>
  );
}

function TopTabBar() {
  return (
    <div className="flex items-end border-b border-neutral-800 bg-neutral-950 pl-20">
      <TopTab to="/loops">Loops</TopTab>
      <TopTab to="/workshop">Context Workshop</TopTab>
      <TopTab to="/live">Live</TopTab>
      <TopTab to="/settings">Settings</TopTab>
    </div>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  const location = useLocation();
  const active = location.pathname === to;

  return (
    <Link
      to={to}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
      }`}
    >
      {children}
    </Link>
  );
}

function Sidebar() {
  const [showLaunch, setShowLaunch] = useState(false);

  return (
    <nav className="flex w-64 flex-col border-r border-neutral-800">
      {/* Top nav */}
      <div className="flex flex-col gap-1 border-b border-neutral-800 p-3">
        <h1 className="mb-2 px-2 text-lg font-semibold tracking-tight">
          promptctl
        </h1>
        <NavLink to="/loops">Panes</NavLink>
        <NavLink to="/loops/commands">Commands</NavLink>
        <NavLink to="/loops/prompts">Prompts</NavLink>
      </div>

      {/* Tmux tree */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            tmux
          </span>
          <button
            onClick={() => setShowLaunch(true)}
            className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
            title="Launch new tool session"
          >
            +
          </button>
        </div>
        <TmuxTree />
      </div>

      {showLaunch && <LaunchToolDialog onClose={() => setShowLaunch(false)} />}
    </nav>
  );
}

// [LAW:one-source-of-truth] Route persisted in ~/.promptctl/settings.json via settings IPC.
// Deep-link URLs (promptctl://open?...) carry a sessionId query param; when
// present, the URL wins over the persisted route.
function RouteRestorer() {
  const navigate = useNavigate();
  const location = useLocation();
  const restored = useRef(false);

  // Restore saved route on first mount
  useEffect(() => {
    window.electronAPI.invoke("settings:load").then((settings) => {
      const params = new URLSearchParams(location.search);
      const hasDeepLink = params.has("sessionId");
      if (
        !hasDeepLink &&
        settings.lastRoute &&
        settings.lastRoute !== location.pathname
      ) {
        navigate(settings.lastRoute, { replace: true });
      }
      restored.current = true;
    });
  }, []);

  // Persist route on every navigation after restore
  useEffect(() => {
    if (!restored.current) return;
    window.electronAPI.invoke("settings:save", {
      lastRoute: location.pathname,
    });
  }, [location.pathname]);

  return null;
}

function LoopsLayout() {
  return (
    <div className="flex flex-1 overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <main className="flex-1 overflow-hidden p-6">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/commands" element={<CommandsPage />} />
            <Route path="/prompts" element={<PromptsPage />} />
          </Routes>
        </main>
        <CommandBar />
      </div>
    </div>
  );
}

export function App() {
  usePaneKeymapListener();

  useEffect(() => {
    const unsubProxy = initProxySubscription();
    let unsubCommand: (() => void) | undefined;
    let unsubLaunch: (() => void) | undefined;
    // [LAW:no-silent-fallbacks] If the App unmounts before either
    // async init resolves, the cleanup runs without the eventual
    // unsubscribe handle. Without this flag, the late-arriving handle
    // would land in a closed-over variable and never be called,
    // leaking the IPC subscription. The flag closes the race: any
    // unsub that resolves after dispose is invoked immediately.
    let disposed = false;

    initCommandSubscription().then((unsub) => {
      if (disposed) unsub();
      else unsubCommand = unsub;
    });
    initLaunchSubscription().then((unsub) => {
      if (disposed) unsub();
      else unsubLaunch = unsub;
    });

    return () => {
      disposed = true;
      unsubProxy();
      unsubCommand?.();
      unsubLaunch?.();
    };
  }, []);

  return (
    <HashRouter>
      <RouteRestorer />
      <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
        <TopTabBar />
        <div className="flex flex-1 overflow-hidden">
          <Routes>
            <Route path="/loops/*" element={<LoopsLayout />} />
            <Route
              path="/workshop"
              element={
                <main className="flex-1 overflow-auto p-6">
                  <SessionsPage />
                </main>
              }
            />
            <Route
              path="/live"
              element={
                <main className="flex flex-1 flex-col overflow-hidden">
                  <Live />
                </main>
              }
            />
            <Route
              path="/settings"
              element={
                <main className="flex-1 overflow-auto p-6">
                  <Settings />
                </main>
              }
            />
            <Route
              path="/debug/tmux-control"
              element={
                <main className="flex flex-1 flex-col overflow-auto">
                  <TmuxControlDebug />
                </main>
              }
            />
            <Route path="*" element={<Navigate to="/loops" replace />} />
          </Routes>
        </div>
      </div>
    </HashRouter>
  );
}
