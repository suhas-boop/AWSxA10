import { AppProvider } from "./state";
import { useRoute } from "./lib/router";
import { Shell } from "./components/Shell";
import { RemindersSection, RoutineSection } from "./components/Sections";
import Home from "./pages/Home";
import Consent from "./pages/Consent";
import Chat from "./pages/Chat";
import ChatStage from "./pages/ChatStage";
import Nurse from "./pages/Nurse";

function Routes() {
  const route = useRoute();

  if (route === "/chat") return <Chat />;
  if (route === "/chat2") return <ChatStage />;
  if (route === "/nurse") return <Nurse />;

  return (
    <Shell route={route}>
      {route === "/routine" ? <RoutineSection /> : route === "/reminders" ? <RemindersSection /> : route === "/consent" ? <Consent /> : <Home />}
    </Shell>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Routes />
    </AppProvider>
  );
}
