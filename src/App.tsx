import { useEffect, useState } from "react";
import { fetchConfigStatus, fetchVllmHealth, fetchVllmMetrics } from "./api";
import { AppHeader } from "./components/AppHeader";
import { ConfigTab } from "./components/ConfigTab";
import { ManualRequestTab } from "./components/ManualRequestTab";
import { AppTab, ConfigStatus, VllmHealth, VllmMetrics } from "./types";

export function App() {
  const [activeTab, setActiveTab] = useState<AppTab>("config");
  const [vllmMetrics, setVllmMetrics] = useState<VllmMetrics | null>(null);
  const [vllmHealth, setVllmHealth] = useState<VllmHealth | null>(null);
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  const [configError, setConfigError] = useState("");

  useEffect(() => {
    let active = true;

    const refreshConfig = async () => {
      try {
        const nextConfig = await fetchConfigStatus();
        if (active) {
          setConfigStatus(nextConfig);
          setConfigError("");
        }
      } catch (caught) {
        if (active) setConfigError(caught instanceof Error ? caught.message : "Config unavailable");
      }
    };

    const refreshMonitoring = async () => {
      try {
        const [nextMetrics, nextHealth] = await Promise.all([fetchVllmMetrics(), fetchVllmHealth()]);
        if (active) {
          setVllmMetrics(nextMetrics);
          setVllmHealth(nextHealth);
        }
      } catch (caught) {
        if (active) {
          const message = caught instanceof Error ? caught.message : "vLLM unavailable";
          setVllmMetrics({ num_requests_running: null, num_requests_waiting: null, available: false, error: message });
          setVllmHealth({ available: false, error: message });
        }
      }
    };

    void refreshConfig();
    void refreshMonitoring();
    const configIntervalId = window.setInterval(refreshConfig, 5000);
    const monitoringIntervalId = window.setInterval(refreshMonitoring, 1000);

    return () => {
      active = false;
      window.clearInterval(configIntervalId);
      window.clearInterval(monitoringIntervalId);
    };
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <AppHeader activeTab={activeTab} onTabChange={setActiveTab} metrics={vllmMetrics} health={vllmHealth} />
      {activeTab === "config" ? <ConfigTab config={configStatus} error={configError} /> : null}
      {activeTab === "manual-request" ? <ManualRequestTab /> : null}
    </main>
  );
}
