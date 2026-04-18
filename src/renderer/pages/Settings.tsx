import { useEffect, useState, useCallback } from "react";

interface SettingsState {
  openaiApiKey: string;
  openaiModel: string;
  compressSummarizeThreshold: number;
  compressTruncateThreshold: number;
  compressKeepLastN: number;
}

const MODELS = [
  "gpt-5.4",
  "gpt-4o",
];

export function Settings() {
  const [settings, setSettings] = useState<SettingsState>({
    openaiApiKey: "",
    openaiModel: "gpt-5.4",
    compressSummarizeThreshold: 5000,
    compressTruncateThreshold: 1000,
    compressKeepLastN: 3,
  });
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    window.electronAPI
      .invoke("settings:load")
      .then((s) => setSettings(s as SettingsState));
  }, []);

  const handleSave = useCallback(async () => {
    await window.electronAPI.invoke("settings:save", settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [settings]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save first so the key is available
      await window.electronAPI.invoke("settings:save", settings);
      // Try a minimal compression call
      const result = (await window.electronAPI.invoke(
        "llm:suggest-compression",
        `settings-test-${Date.now()}`,
        [
          {
            index: 0,
            id: "test",
            type: "user",
            timestamp: "",
            tokens: 5,
            preview: "hello world",
            hasToolCalls: false,
            hasToolResults: false,
            toolNames: [],
            flags: [],
            extras: {},
          },
        ],
      )) as unknown[];
      setTestResult(
        Array.isArray(result)
          ? "Connection successful"
          : "Unexpected response format",
      );
    } catch (e) {
      setTestResult(`Error: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }, [settings]);

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="mt-2 text-neutral-400">
          Configure API keys and model preferences.
        </p>
      </div>

      <div className="space-y-6 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <div>
          <h3 className="text-lg font-semibold text-neutral-200">
            OpenAI API
          </h3>
          <p className="mt-1 text-sm text-neutral-500">
            Powers Smart Compress and Topic Focus in Context Workshop.
            Uses a separate, cost-effective model to analyze conversations.
          </p>
        </div>

        {/* API Key */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-neutral-300">
            API Key
          </label>
          <input
            type="password"
            value={settings.openaiApiKey}
            onChange={(e) =>
              setSettings((s) => ({ ...s, openaiApiKey: e.target.value }))
            }
            placeholder="sk-..."
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500"
          />
          <p className="text-sm text-neutral-600">
            Stored locally at ~/.promptctl/settings.json. Never sent anywhere
            except the OpenAI API.
          </p>
        </div>

        {/* Model */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-neutral-300">
            Model
          </label>
          <select
            value={settings.openaiModel}
            onChange={(e) =>
              setSettings((s) => ({ ...s, openaiModel: e.target.value }))
            }
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <p className="text-sm text-neutral-600">
            Used for context analysis and topic segmentation. Cheaper models
            work well here — the heavy lifting is pattern recognition, not generation.
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500"
          >
            Save
          </button>
          <button
            onClick={handleTest}
            disabled={!settings.openaiApiKey || testing}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 transition-colors hover:bg-neutral-800 disabled:opacity-30"
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {saved && (
            <span className="text-sm text-green-400">Saved</span>
          )}
          {testResult && (
            <span
              className={`text-sm ${testResult.startsWith("Error") ? "text-red-400" : "text-green-400"}`}
            >
              {testResult}
            </span>
          )}
        </div>
      </div>

      {/* Tool result compression thresholds */}
      <div className="space-y-6 rounded-xl border border-neutral-800 bg-neutral-900 p-6">
        <div>
          <h3 className="text-lg font-semibold text-neutral-200">
            Tool Result Compression
          </h3>
          <p className="mt-1 text-sm text-neutral-500">
            Controls the "Compress Tools" button. Large tool results get
            summarized (LLM), medium results get truncated (cheap), small
            results stay untouched.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-neutral-300">
              Summarize at (tokens)
            </label>
            <input
              type="number"
              min={0}
              value={settings.compressSummarizeThreshold}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  compressSummarizeThreshold: Number(e.target.value),
                }))
              }
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            />
            <p className="text-sm text-neutral-600">
              Results at or above this count are sent to the LLM for
              summarization. Requires an API key.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-neutral-300">
              Truncate at (tokens)
            </label>
            <input
              type="number"
              min={0}
              value={settings.compressTruncateThreshold}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  compressTruncateThreshold: Number(e.target.value),
                }))
              }
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            />
            <p className="text-sm text-neutral-600">
              Results at or above this count (but below the summarize
              threshold) get head/tail truncated. Below this they are left
              alone.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-neutral-300">
              Protect last N results
            </label>
            <input
              type="number"
              min={0}
              value={settings.compressKeepLastN}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  compressKeepLastN: Number(e.target.value),
                }))
              }
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-500"
            />
            <p className="text-sm text-neutral-600">
              The last N tool results are never compressed — the assistant
              often references them on the next turn.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
