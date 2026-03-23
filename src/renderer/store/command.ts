import { create } from "zustand";
import type {
  Command,
  CommandEvent,
  CommandId,
  CommandTarget,
  CommandAction,
  CommandTrigger,
} from "../../shared/types";

interface CommandStore {
  commands: Command[];
  events: CommandEvent[];
  setCommands: (commands: Command[]) => void;
  addEvent: (event: CommandEvent) => void;
  addCommand: (
    name: string,
    target: CommandTarget,
    action: CommandAction,
    trigger: CommandTrigger,
  ) => Promise<void>;
  removeCommand: (id: string) => Promise<void>;
  toggleCommand: (id: string) => Promise<void>;
  fireCommand: (id: string) => Promise<void>;
}

export const useCommandStore = create<CommandStore>((set, get) => ({
  commands: [],
  events: [],
  setCommands: (commands) => set({ commands }),
  addEvent: (event) =>
    set((state) => ({
      events: [...state.events.slice(-99), event],
    })),
  addCommand: async (name, target, action, trigger) => {
    const command: Command = {
      id: crypto.randomUUID() as CommandId,
      name,
      target,
      action,
      trigger,
      enabled: true,
      lastRun: null,
      runCount: 0,
    };
    await window.electronAPI.invoke("command:add", command);
  },
  removeCommand: async (id) => {
    await window.electronAPI.invoke("command:remove", id);
  },
  toggleCommand: async (id) => {
    const command = get().commands.find((c) => c.id === id);
    if (!command) return;
    await window.electronAPI.invoke("command:update", id, {
      enabled: !command.enabled,
    });
  },
  fireCommand: async (id) => {
    await window.electronAPI.invoke("command:fire", id);
  },
}));

export async function initCommandSubscription(): Promise<() => void> {
  const commands = (await window.electronAPI.invoke(
    "command:list",
  )) as Command[];
  useCommandStore.getState().setCommands(commands);

  const unsubList = window.electronAPI.on("command:list", (commands) => {
    useCommandStore.getState().setCommands(commands as Command[]);
  });

  const unsubEvents = window.electronAPI.on("command:event", (event) => {
    useCommandStore.getState().addEvent(event as CommandEvent);
  });

  window.electronAPI.send("command:subscribe");

  return () => {
    unsubList();
    unsubEvents();
  };
}
