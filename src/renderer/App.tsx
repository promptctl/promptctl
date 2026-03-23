import { useEffect, useState } from "react";
import { HashRouter, Routes, Route, Link, useLocation } from "react-router";
import { Home } from "./pages/Home";
import { Settings } from "./pages/Settings";
import { CommandsPage } from "./pages/Commands";
import { SessionsPage } from "./pages/Sessions";
import { TmuxTree } from "./components/TmuxTree";
import { CommandBar } from "./components/CommandBar";
import { LaunchToolDialog } from "./components/LaunchToolDialog";
import { initTmuxSubscription } from "./store/tmux";
import { initOutputSubscription } from "./store/pane-output";
import { initCommandSubscription } from "./store/command";

function NavLink({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}) {
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
        <NavLink to="/">Panes</NavLink>
        <NavLink to="/commands">Commands</NavLink>
        <NavLink to="/sessions">Sessions</NavLink>
        <NavLink to="/settings">Settings</NavLink>
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

      {showLaunch && (
        <LaunchToolDialog onClose={() => setShowLaunch(false)} />
      )}
    </nav>
  );
}

export function App() {
  useEffect(() => {
    const unsubTmux = initTmuxSubscription();
    const unsubOutput = initOutputSubscription();
    let unsubCommand: (() => void) | undefined;

    initCommandSubscription().then((unsub) => {
      unsubCommand = unsub;
    });

    return () => {
      unsubTmux();
      unsubOutput();
      unsubCommand?.();
    };
  }, []);

  return (
    <HashRouter>
      <div className="flex h-screen bg-neutral-950 text-neutral-100">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <main className="flex-1 overflow-hidden p-6">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/commands" element={<CommandsPage />} />
              <Route path="/sessions" element={<SessionsPage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
          <CommandBar />
        </div>
      </div>
    </HashRouter>
  );
}
