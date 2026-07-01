import { AppHeader } from "./components/AppHeader";
import { ConfigTab } from "./components/ConfigTab";

export function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <AppHeader />
      <ConfigTab />
    </main>
  );
}
