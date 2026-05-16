
❯ I want you to evaluate the implementation we did in this project for this ticket: 77e.1.5

  Against the example app implementation in ~/code/tmux-control-mode-js

  Give me divergences, and pros and cons of each implementation where they are different.  If you see any obvious
  deficiencies in either, provide me an analysis of those too

...

⏺ ★ Insight ─────────────────────────────────────
  The 77e.1.5 ticket replaces a "byte-block debug pane" with an actual xterm.js terminal — meaning the previous
  debug surface was rendering raw output bytes as visible blocks (a debug-friendly but useless-for-real-rendering
  view), and this swaps it for a proper VT-emulating terminal that can show colors, cursor positioning, ANSI
  escapes, etc. Both promptctl and the example app implement this same idea, but they differ in framing: promptctl
  uses xterm.js inside React; the example uses plain TS classes.
  ─────────────────────────────────────────────────

  ---
  77e.1.5 — promptctl PaneTerminal vs example pane-terminal.ts

  ★ Insight ─────────────────────────────────────
  Both implementations solve the same problem (render a live tmux pane in a browser-side terminal emulator), and
  they make different correct-feeling tradeoffs because they are aimed at different scopes. Promptctl is a
  single-pane debug surface on a path to becoming the real Loops UI; the example is a working multi-pane
  multiplexer. Reading one as a copy of the other is misleading — they have diverged structurally because their
  requirements diverged.
  ─────────────────────────────────────────────────

  Scope at a glance

  ┌─────────────────────┬────────────────────────────────────────┬──────────────────────────────────────────────┐
  │                     │       promptctl PaneTerminal.tsx       │           example pane-terminal.ts           │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ LOC                 │ 135                                    │ 471                                          │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Form                │ React component (useEffect)            │ Plain TS class (mount/dispose)               │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ State management    │ React state in callers                 │ MobX observables + reaction()                │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Panes rendered      │ 1 (debug)                              │ N (window grid)                              │
  │ concurrently        │                                        │                                              │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Seed source         │ main-side output-router capture-pane   │ renderer-side capture-pane in seed()         │
  │                     │ on first watcher                       │                                              │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Seed buffering      │ none                                   │ yes (idle → seeding → live state machine)    │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Cursor restore      │ no                                     │ yes (display-message #{cursor_x};#{cursor_y} │
  │                     │                                        │  + CUP)                                      │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Sizing direction    │ xterm → tmux (FitAddon, setSize)       │ tmux → xterm (no FitAddon,                   │
  │                     │                                        │ font-fits-container)                         │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Keystroke routing   │ terminal.onData → proxy.sendKeys       │ terminal.onData → store.sendKeysToPane, plus │
  │                     │                                        │  document-level keymap                       │
  ├─────────────────────┼────────────────────────────────────────┼──────────────────────────────────────────────┤
  │ Chunk delivery      │ per-pane subscribe on main; main only  │ global client.onEvent filtered by paneId in  │
  │                     │ sends to subscribed wcs                │ callback                                     │
  └─────────────────────┴────────────────────────────────────────┴──────────────────────────────────────────────┘

  ---
  Major divergences

  1. Seed location and sequencing (the big one)

  promptctl does capture-pane in the main process inside TmuxOutputRouter.subscribe()
  (src/main/tmux/output-router.ts:79-81, :179-189). The captured text is broadcast as a tmux:output:chunk event —
  same channel as live byte streams. The router fires-and-forgets the capture (void this.captureScrollback(paneId))
  and continues to broadcast live output events immediately as they arrive.

  example does capture-pane from inside the renderer-side PaneTerminal class with a 4-state lifecycle (idle →
  seeding → live → disposed, pane-terminal.ts:202, :328-330, :345-400). During seeding, live byte events from
  client.onEvent are buffered into a Uint8Array[] rather than written. After the capture-pane reply lands, the
  captured text plus an ANSI cursor-position escape get written, then the buffer is drained synchronously, then
  state flips to live. No await exists between the first write and the mode flip, so no live event can interleave.

  Column 1: promptctl (main-side, no buffer)
  pros: ✓ Renderer is dumb — just writes chunks. ✓ Easier to test the renderer in isolation. ✓ Reuses the existing
    IPC channel — no second event path. ✓ Multiple watchers share one capture cost.
  cons: ✗ Race condition: live output events arriving during the capture-pane round-trip get broadcast before the
    scrollback chunk. The renderer renders live data, then scrollback overwrites/follows it — out-of-order display.
  ✗
     No cursor-position restore — after the seed the xterm cursor sits at the bottom of the captured buffer, not
    where the shell prompt actually is. ✗ Re-capture on reconnect (output-router.ts:143-150) has the same race.
  ────────────────────────────────────────
  Column 1: example (renderer-side, buffered)
  pros: ✓ Strict ordering: capture written first, buffered live events drained after, mode flip in the same tick. ✓
    Cursor restore via display-message. ✓ State machine is explicit — idle/seeding/live/disposed is a clear
  contract.
  cons: ✗ Each terminal does its own capture — N watchers = N captures. ✗ More logic in the renderer. ✗ Timing of
    "events buffered before listener installed" relies on the onEvent listener being installed before capture-pane
  is
     sent (which it is — see pane-terminal.ts:260-272, :328-329).

  This is a real promptctl bug, not a stylistic difference. It will not bite the debug surface most of the time
  because tmux panes spend most of their life idle, but a pane that's actively writing during click-to-watch will
  display incorrectly. The [LAW:dataflow-not-control-flow] comment at the top of PaneTerminal.tsx is honest about
  chunks-for-other-panes being filtered by value, but the temporal dataflow (capture → live, in order) is not
  guaranteed by the current router.

  2. Sizing — opposite directions

  promptctl mounts FitAddon, calls fit.fit() once requestAnimationFrame fires, observes container resize and
  re-fits. Each terminal.onResize sends proxy.setSize(cols, rows), which the library encodes as refresh-client -C
  WIDTHxHEIGHT. The xterm container is the size authority; tmux follows.

  example explicitly removes FitAddon (pane-terminal.ts:232-237) and drives term.resize(cols, rows) from a MobX
  reaction() reading pane.width/height from the store and terminalFontSize from the UI store. Font size is picked
  manually via toolbar +/-. tmux is the size authority; xterm follows.

  Column 1: promptctl (xterm → tmux)
  pros: ✓ Browser container fully fills with terminal. ✓ Resizing the window "feels right" — stretch the window,
  more
    cols. ✓ Simpler conceptually for a single-pane view.
  cons: ✗ refresh-client -C sets the whole client/window size, not a single pane. With multiple panes in one window,

    two PaneTerminals in the same renderer would fight over the client size every resize event. Not yet a problem
    because debug shows one at a time, but it does not generalize to Loops panes view. ✗ Constant setSize calls
    round-trip to tmux on every container resize tick (debounced only by ResizeObserver coalescing). ✗ Comment at
    line 81-83 says "tmux propagates the size to its pane sizing" — that's only true for the active pane's window,
    and only because there's a single client; this is a leaky assumption.
  ────────────────────────────────────────
  Column 1: example (tmux → xterm)
  pros: ✓ Generalizes naturally to N panes — each xterm sizes to whatever tmux says its pane is. ✓ No refresh-client

    -C traffic on every resize. ✓ Decouples display from the tmux sizing model — the user's font choice doesn't
    perturb tmux.
  cons: ✗ User has to pick font size manually (toolbar). ✗ Custom font measurement (measureOnce, fitFontSize) is
  real
    code that has to be maintained. ✗ Container can have unused pixels at the edge.

  Recommendation for promptctl: the FitAddon model works for the debug surface today, but it will break the moment
  the Loops Panes page renders multiple panes simultaneously. Borrow the example's tmux-as-authority model before
  that slice lands — otherwise multiple PaneTerminals will issue contradictory refresh-client -C calls.

  3. Class vs hook stew

  promptctl is a React functional component. The whole xterm lifecycle is one useEffect([paneId]). Cleanup tears
  down xterm and unsubscribes. There is no class.

  example is an imperative class instantiated inside useEffect of PaneCell. The class owns: xterm, ResizeObserver,
  MobX disposers, event listener, lifecycle state, seed buffer.

  The example's header comment (pane-terminal.ts:9-19) explains the choice directly: "The xterm lifecycle is
  imperative at the edges (constructor / open / write / resize / dispose). Wrapping that in a class keeps the
  imperative code cohesive and testable. The reactive derivations (font size, resize, seeding state machine) live
  inside MobX reactions declared in mount(). React's useEffect dependency arrays do not model 'derive side effect
  from observable state' cleanly; reaction() does."

  Column 1: promptctl (component)
  pros: ✓ One file, conventional React. ✓ Mounts/unmounts via React tree — the parent decides lifetime. ✓ Test
    surface is "render the component, drive it via mocks." ✓ Pairs cleanly with Zustand/IPC subscription pattern
  used
     elsewhere in the renderer.
  cons: ✗ All lifecycle stuck in one closure inside useEffect; no method-level seam for tests to hit (e.g. "test
  seed
    buffering in isolation" is hard because there's no seed() to call). ✗ React StrictMode double-invokes the effect

    — currently fine because everything cleans up symmetrically, but more state will need careful handling.
  ────────────────────────────────────────
  Column 1: example (class + hook adapter)
  pros: ✓ Independently testable methods (mount, dispose, seed, applySizing, focus). ✓ Survives container reflow
    without React tearing it down. ✓ MobX reaction() expresses derived effects more precisely than useEffect deps.
  cons: ✗ Two state systems (React for mount, MobX for the rest) — engineers must know both. ✗ More code. ✗
    Imperative mount()/dispose() discipline can be violated if a future caller forgets.

  For promptctl's stack (Zustand, no MobX), the React-component form is the right local choice — adopting MobX just
  for this would be a mode explosion. But the component currently lacks a way to test the seeding lifecycle in
  isolation, because there is no seeding lifecycle in the renderer at all (it's in the main-side router). If you fix
   the race in #1 by moving the seed into the component, the class shape becomes easier to defend.

  4. Subscription model

  promptctl has explicit tmux:output:subscribe / tmux:output:unsubscribe IPC calls. The main-side TmuxOutputRouter
  keeps a per-pane watcher set; output events from tmux are broadcast only to subscribed WebContents. Each renderer
  PaneTerminal subscribes on mount and unsubscribes on unmount.

  example uses client.onEvent(...) — every consumer sees every event and filters by paneId in the callback
  (pane-terminal.ts:260-272). There is no subscription registry on the main side.

  Column 1: promptctl (subscribe registry)
  pros: ✓ Avoids unnecessary IPC traffic — only watched panes emit chunks across the boundary. ✓ Enables the
    pause-after/auto-resume backpressure logic in output-router.ts:122-141. ✓ Natural place to hang per-pane state
    (capture coalescing, multiple watchers sharing one capture).
  cons: ✗ More IPC contract surface (subscribe + unsubscribe + chunk + state = 4 channels for one feature). ✗ The
    router is now a thing that must not drift from the renderer's expectations.
  ────────────────────────────────────────
  Column 1: example (broadcast everything)
  pros: ✓ Zero subscription state. ✓ Each terminal is fully self-contained. ✓ client.onEvent is the same API
    regardless of how many consumers.
  cons: ✗ Bytes for unwatched panes still cross the bridge. ✗ Without a registry, server-side filtering (e.g.
    refresh-client -B subscriptions) must be set up by some other component.

  For promptctl's eventual scale (potentially many panes, some watched, some not), the subscribe model is the right
  call. It is also what makes the seed-bug worse though — the seed is hidden inside the registry, far from the
  renderer that can no longer reason about ordering.

  5. Cursor restoration

  The example issues display-message -p '#{cursor_x};#{cursor_y}' in parallel with capture-pane, then writes an ANSI
   CUP escape (\x1b[<row>;<col>H) after the captured text (pane-terminal.ts:347-386). Without this, after a fresh
  seed the xterm cursor sits at the bottom of the captured buffer — the user types and characters appear on the
  wrong line until tmux echoes back enough output to move the cursor.

  Promptctl does not do this. It would manifest visibly the instant a user clicks "watch" on a pane that has
  scrollback above an active prompt. Easy fix; the missing piece is just the second client.execute call.

  ---
  Other deficiencies / observations

  promptctl

  - scrollback: 10_000 but capture is -S -500. output-router.ts:183 captures only the last 500 lines, so the xterm
  scrollback buffer can never hold pre-watch history beyond that even though it's sized for 10k. Either size them
  consistently or document the deliberate clamp.
  - window.__paneTerminal as a singleton handle. The comment notes that "future multi-pane surfaces will move to a
  registry keyed by paneId." Worth doing now if the Loops Panes page is the next slice — adding a registry later
  means revisiting the test infrastructure that already reads the singleton. (PaneTerminal.tsx:25-30, :67,
  PaneTerminal.test.tsx:65-71)
  - No backpressure between IPC chunks and xterm. xterm has its own WriteBuffer that flushes on a microtask, so this
   is mostly fine, but very chatty panes (e.g. yes) bypass the auto-resume in the router because pause-after=2 only
  fires after tmux's own buffer fills. Fine for debug; worth thinking about for Loops.
  - Re-capture on reconnect re-emits the entire scrollback as a single tmux:output:chunk. output-router.ts:143-150
  re-fires capture for every watched pane on ready, but doesn't clear the xterm buffer first. The user sees the old
  scrollback, then the new one stacked under it. The example has the same shape but its state machine resets to
  seeding on disconnect (... actually, looking again, the example's handling of reconnect is not in this file —
  that's a fair concern there too if it's not handled elsewhere).

  example

  - Each PaneTerminal does its own capture-pane even with shared backing. N panes watching same window = N captures.
   Probably fine — captures are cheap — but there is no de-duplication.
  - MobX leak risk if the disposer array isn't drained. pane-terminal.ts:456 drains it correctly; if anyone adds a
  code path that returns early from mount() after pushing a disposer, that's a leak.
  - document.fonts font-load race. refreshBaseMetrics() only refires once on the initial page load
  (pane-terminal.ts:110-117). If a subsequent navigation re-imports fonts, the cache won't re-measure. Module-scope
  side effect is a small smell.

  ---
  Recommendations for promptctl

  In rough priority order:

  1. Fix the seed-vs-live race. Two options: (a) move the seed into the renderer-side PaneTerminal and adopt the
  example's idle/seeding/live state machine; or (b) keep the seed on the main side but buffer outgoing chunks until
  the capture resolves and emit them in order from the router. (a) is closer to the example and gives you the cursor
   restore for free; (b) keeps test surface thinner. I'd pick (a).
  2. Add cursor restore. Trivial follow-up after #1.
  3. Reverse the sizing direction before Loops Panes lands. Multiple PaneTerminals issuing refresh-client -C will
  fight; let tmux's pane dimensions drive xterm cols/rows.
  4. Reconcile the scrollback ceiling. Either capture -S -10000 to match xterm's scrollback, or shrink xterm's
  scrollback to match what you capture.
  5. Promote the __paneTerminal global to a Map<PaneId, ...> registry, since the multi-pane surface is on the road
  map and the test-side reader is easy to migrate.

✻ Sautéed for 3m 22s

※ recap: We compared promptctl's PaneTerminal (77e.1.5) against the tmux-control-mode-js example app, and produced a
   divergence analysis with pros/cons and deficiencies. Next: decide whether to fix the seed-vs-live race by moving
  seeding into the renderer.

❯ Promptctl IS quite literally a copy of the example app.  I told another session to copy it.  Frankly this is a
  huge amount of information.  It's also somewhat disappointing and requires a concerted effort to resolve numerous
   problems.  It is sounding like both implementations are fairly bad and have an unfortunate amount of
  differences.  The demo app actually works very well though, and my hope was to avoid reimplemenmting the same
  performance fixes, bugfixes, and just generally tracking down all of the weird escape sequence stuff in every
  project that uses tmux-control-mode-js, forever.

  I'll copy your report into a document so i can spend some time analyzing it, because it's quite long, but even
  just skimming it I think our plan will be to design PaneTerminal in such a way that it's flexible enough to drop
  into any app that is using the library and wants to use it, then uptaking it in this repo.  Can you help design
  that surface to ensure it takes the best parts of either implementation and remains flexible enough for common
  usage?  There is absolutely no room for slack on any of these things:
  - Memory usage / proper cleanup / lifecycle
  - ANSI escape sequence handling, including input
  - Performance, esp w/ realtime out + input
  - Long histories

  There might be 2 dozen of these on a page with 1-4ish visible at a time.  It must feel instant.  What I'm looking
   for now is probably a condensed, focused analysis that helps get this work on the right track.  The goal being:

  - Design API surface by analyzing the two existing implementations (this is what we're doing now)
  - Implement this in the demo app in tmux-control-mode-js
  - Once fully implemented and working, pull that functionality back up into the library (likely a separate package
   in the same repo to avoid pulling xtermjs in with the main lib)
  - This project uptakes the library package and we get rid of our own tmux-xtermjs renderer code

  Thoughts or concerns?

⏺ ★ Insight ─────────────────────────────────────
  The two implementations look different because each fused two distinct concerns into one object: the data stream
  for a pane (bytes, seed lifecycle, activity) and the renderer for it (xterm.js, sizing, keystrokes). Once you
  split those, the 24/4 case (many tracked, few rendered) becomes trivial — and the seed-race, cursor-restore,
  scrollback-ceiling, and sizing-conflict bugs all collapse to single-source fixes. This is also why the work is
  portable across apps: every consumer wants the same stream contract; only the renderer wiring is app-specific.
  ─────────────────────────────────────────────────

  The fundamental split

  PaneStream  (lightweight, 24 instances)   ─── owns: state machine, seed,
                                                 buffering, live subscription,
                                                 capture-pane + cursor query
         │                                       lives as long as you "track"
         │  attach(sink) / detach()              the pane
         ▼
  TerminalSink  (interface, 1-4 instances)  ─── what a renderer must implement:
                                                 write/seed/resize/clear
         │
         ▼
  XtermSink     (xterm.js impl)             ─── owns: Terminal, FitAddon (opt),
                                                 container, fonts, key dispatch
                                                 heavy. Created on visibility,
                                                 disposed on hide.

  Lifecycle independence is the whole point. A stream with no sink attached doesn't need an xterm — but it also
  doesn't need to retain bytes, because tmux already has the scrollback. On attach, the stream issues capture-pane
  -e -p -S - + display-message #{cursor_x};#{cursor_y}, buffers live events, drains them after the cursor write,
  flips to live. This is the example's seed flow, just hoisted out of the renderer so it survives renderer churn.

  Proposed package layout

  tmux-control-mode-js/
  ├── src/                              # main lib (no xterm dep)
  └── packages/
      └── pane-terminal/
          ├── src/
          │   ├── stream.ts             # PaneStream — depends on main lib only
          │   ├── sink.ts               # TerminalSink interface, BufferingSink helper
          │   ├── xterm-sink.ts         # XtermSink — depends on xterm.js
          │   ├── react.tsx             # PaneTerminal React adapter (peer-dep React)
          │   └── index.ts
          └── package.json              # peer-deps: tmux-control-mode-js, xterm, react

  xterm.js lives behind its own subpath. Apps that want headless tracking (no UI) can use just pane-terminal/stream
  without paying the xterm import cost.

  Proposed API

  // ─── stream.ts ─────────────────────────────────────────────────────
  // One per tracked pane. Cheap. Survives renderer churn.

  export interface PaneStreamOptions {
    readonly paneId: number
    readonly client: TmuxClient
    /** Capture extent on attach. `'visible'` | `'all'` | number-of-lines. Default 'all'. */
    readonly captureRange?: 'visible' | 'all' | number
    /** Track byte counts while detached for activity UI. Default true. */
    readonly trackActivityWhileDetached?: boolean
  }

  export type PaneStreamState = 'idle' | 'seeding' | 'live' | 'disposed'

  export interface PaneActivity {
    readonly lastByteAt: number          // epoch ms; 0 if never
    readonly bytesSinceLastAttach: number
  }

  export class PaneStream {
    readonly paneId: number
    readonly state: PaneStreamState

    constructor(opts: PaneStreamOptions)

    /** Wire up a sink. Issues capture-pane + cursor query, buffers live bytes,
     *  writes seed + cursor + drained buffer in order, flips to live.
     *  Idempotent: attaching while attached is a no-op. */
    attach(sink: TerminalSink): void

    /** Disconnect the sink. Stream stays alive; bytes either drop or fill the
     *  activity counter (per options). Re-attach later → fresh capture. */
    detach(): void

    /** Per-stream activity signal. Observable via `onActivity` for UI badges. */
    readonly activity: PaneActivity
    onActivity(handler: (a: PaneActivity) => void): () => void

    /** Push the user's chosen size to tmux. Use only in 'fit-container' wiring. */
    setSize(cols: number, rows: number): Promise<void>

    /** Send literal bytes to the pane (`send-keys -l`). */
    sendKeys(data: string): Promise<void>

    /** Free everything. After dispose, attach/detach/sendKeys throw. */
    dispose(): void
  }

  // ─── sink.ts ───────────────────────────────────────────────────────
  // What a renderer must implement. Bytes-first; never string-only.

  export interface CursorPosition {
    readonly col: number  // 0-indexed
    readonly row: number  // 0-indexed
  }

  export interface TerminalSink {
    /** Initial state from capture-pane + display-message. Always called once
     *  per attach, before any write(). Sink should clear any prior content. */
    seed(captured: Uint8Array, cursor: CursorPosition | null): void

    /** Live bytes from tmux. Hot path — keep it allocation-free if possible. */
    write(data: Uint8Array): void

    /** Tmux pane geometry changed (in 'follow-pane' mode) or user requested
     *  a size (in 'fit-container' mode). Sink resizes its underlying terminal. */
    resize(cols: number, rows: number): void
  }

  // ─── xterm-sink.ts ──────────────────────────────────────────────────
  // The heavy thing. One per visible pane. Created on mount, disposed on hide.

  export type SizingMode = 'fit-container' | 'follow-pane'

  export interface XtermSinkOptions {
    readonly container: HTMLElement
    readonly sizingMode: SizingMode
    readonly fontFamily?: string
    readonly fontSize?: number          // used only in 'follow-pane'
    readonly fontMin?: number           // 'follow-pane' clamp; default 6
    readonly fontMax?: number           // 'follow-pane' clamp; default 16
    readonly scrollback?: number        // default 10_000
    readonly theme?: { background?: string; foreground?: string }
  }

  export class XtermSink implements TerminalSink {
    constructor(opts: XtermSinkOptions)

    /** Forward keystrokes to your stream: sink.onData(d => stream.sendKeys(d)). */
    onData(handler: (data: string) => void): () => void

    /** Forward resize signal in 'fit-container' mode. No-op in 'follow-pane'. */
    onResize(handler: (cols: number, rows: number) => void): () => void

    /** Required wiring: focus the underlying terminal. */
    focus(): void

    /** Direct buffer access for tests + Playwright assertions. */
    readonly terminal: import('@xterm/xterm').Terminal

    dispose(): void
  }

  // ─── react.tsx ──────────────────────────────────────────────────────
  // Glue. Stream is owned by the caller (likely a parent that tracks all
  // 24 panes). Only the visible panes get a <PaneTerminal>.

  export interface PaneTerminalProps {
    readonly stream: PaneStream
    readonly sizingMode: SizingMode
    readonly fontFamily?: string
    readonly fontSize?: number
    readonly scrollback?: number
    readonly theme?: { background?: string; foreground?: string }
    readonly className?: string
    readonly onFocus?: () => void
  }

  export function PaneTerminal(props: PaneTerminalProps): JSX.Element

  How this hits each hard requirement

  Memory / cleanup / lifecycle. Two clean ownership boundaries: caller owns the PaneStream (24 instances;
  lightweight); the React tree (or vanilla mount code) owns XtermSink (1-4 instances; heavy). Hide a pane → its sink
   disposes → xterm gone, DOM gone, Terminal's per-instance allocations gone. Stream stays. Re-show → fresh sink,
  fresh capture-pane, no stale state. Stream's dispose() is the only thing the consumer must remember to call when
  done tracking; the sink is auto-released by React unmount.

  ANSI handling. Bytes-only at every boundary. PaneStream.write takes Uint8Array; TerminalSink.seed and .write take
  Uint8Array. xterm.js accepts Uint8Array natively and runs it through its own VT parser — it already handles the
  universe of escape sequences correctly, including the messy ones (OSC, DCS, mouse, bracketed paste, focus events).
   For input, XtermSink.onData returns the strings xterm emits, including pre-encoded escape sequences for arrow
  keys / function keys / mouse — pass straight to stream.sendKeys, which the library encodes as send-keys -l
  (literal, no shell expansion). Promptctl's current main-side TextDecoder('utf-8') → string → Uint8Array round-trip
   needs to die — it corrupts non-UTF8 bytes (CSI parameter bytes, raw 8-bit control chars in some apps).

  Performance, real-time. Hot path is tmux library Uint8Array → IPC → sink.write(Uint8Array) →
  xterm.write(Uint8Array). Zero string conversions, zero copies beyond what the IPC channel forces. xterm batches
  via its WriteBuffer, which already coalesces dozens of writes per frame. For the 24/4 case: detached streams don't
   subscribe to live output by default — they only listen to a lightweight activity heartbeat (the output event, but
   only inspected for byte length and timestamp). Cost of an idle stream: one event listener, ~64 bytes of state.
  Visible panes pay the rendering cost; invisible ones don't.

  Long histories. No second copy of history outside xterm. On attach, full scrollback comes from capture-pane -e -p
  -S - (the 'all' default, no clamp). xterm holds it in its scrollback ring; the option lets the user size that ring
   (default 10k lines is plenty). Detached panes don't keep history at all — tmux owns it; we re-fetch on attach.
  This is cheaper than carrying scrollback in the stream because tmux already has it.

  Concerns / things I'd want you to push back on

  1. captureRange: 'all' default vs scrollback ceiling. Capturing 100k lines from tmux on every attach is fine for
  snapshot-style debugging but slow if the user is tab-flicking. I'd default to 'visible' + last N (say 1000) and
  surface a "load full history" affordance, but that's a UX call.
  2. Single sink per stream. The design assumes one renderer at a time. If you want a "thumbnail + full" view of the
   same pane, we'd need either two streams (each with its own seed, slightly drifting) or sink fan-out (tee bytes to
   multiple sinks). Fan-out is two lines of code but doubles the design surface — I'd skip it until someone actually
   asks.
  3. Sizing mode is per-sink, not per-stream. That's intentional — the renderer decides whether it drives or
  follows. But the signal back to tmux in 'fit-container' mode goes via stream.setSize(), which is refresh-client -C
   — still a client-wide call, not per-pane. With 4 visible panes all in 'fit-container' mode, they would fight. So
  'fit-container' is really only sane when exactly one pane is visible and full-size. Worth encoding that as a
  runtime guard, or as a typed "exclusive mode" marker on the stream.
  4. React-only adapter to start. The class API is the substrate; if Solid/Svelte consumers show up, they get
  equivalent thin adapters. Don't ship them speculatively.
  5. Migration path. Implementing this in the demo first means deleting the current pane-terminal.ts and PaneCell
  rewires through the new adapter. That's the right pressure-test — if the demo can't express its current behavior
  on the new surface, the surface is wrong. Plan on one round-trip of "demo refactor reveals missing affordance, add
   it to the surface, repeat." Ideally one or two iterations, not five.
  6. Test substrate. A BufferingSink in sink.ts (records seed/write/resize calls into arrays) is enough to unit-test
   stream behavior without any DOM. Promptctl's current renderer-unit test stubs ResizeObserver and reads
  buffer.active.getLine — those move into the xterm-sink test file and stay there; stream tests become fast,
  deterministic, no JSDOM.

  If the shape feels right, I'd suggest the next step is a 1-2 page IMPL doc inside packages/pane-terminal/ that
  nails down: the seed-then-flip protocol (with sequence diagram), the exact tmux commands issued, the
  activity-counter semantics, and the sizing-mode interaction with refresh-client -C. That doc becomes the contract;
   the code follows it.

