import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ChatMessage, IconName } from "./types";

export type RoutineItem = {
  id: number;
  title: string;
  note: string;
  time: string;
  icon: IconName;
  color: "lime" | "blue" | "pink";
  done: boolean;
};

export type Reminder = {
  id: number;
  when: string;
  period: string;
  day: string;
  title: string;
  note: string;
  icon: IconName;
  done: boolean;
};

export type Prefs = {
  shareRoutine: boolean;
  shareCheckIns: boolean;
  medicationAlerts: boolean;
  voice: boolean;
  camera: boolean;
};

const initialRoutine: RoutineItem[] = [
  { id: 1, title: "Morning medication", note: "1 tablet with breakfast", time: "8:00 AM", icon: "pill", color: "lime", done: true },
  { id: 2, title: "Drink a glass of water", note: "A fresh start for your day", time: "8:30 AM", icon: "water", color: "blue", done: false },
  { id: 3, title: "Gentle morning walk", note: "Around the garden", time: "9:15 AM", icon: "walk", color: "pink", done: false },
];

const initialReminders: Reminder[] = [
  { id: 1, when: "2:00", period: "PM", day: "Today", title: "Blood pressure check", note: "Use the monitor by your bedside", icon: "heart", done: false },
  { id: 2, when: "6:00", period: "PM", day: "Today", title: "Evening medication", note: "2 tablets after dinner", icon: "pill", done: false },
  { id: 3, when: "10:30", period: "AM", day: "Tomorrow", title: "Call with Dr. Miller", note: "Monthly check-in by video", icon: "clock", done: false },
];

const greeting: ChatMessage = {
  id: 1,
  sender: "nurse",
  text: "Good morning, Alice! How are you feeling today?",
};

type AppState = {
  routine: RoutineItem[];
  toggleRoutine: (id: number) => void;
  reminders: Reminder[];
  toggleReminder: (id: number) => void;
  consentChoice: "accepted" | "declined" | null;
  consentOpen: boolean;
  setConsentOpen: (open: boolean) => void;
  chooseConsent: (choice: "accepted" | "declined") => void;
  prefs: Prefs;
  setPref: (key: keyof Prefs, value: boolean) => void;
  checkedIn: boolean;
  setCheckedIn: (v: boolean) => void;
  nurseNotified: boolean;
  setNurseNotified: (v: boolean) => void;
  messages: ChatMessage[];
  addMessage: (m: Omit<ChatMessage, "id">) => number;
  updateMessage: (id: number, patch: Partial<ChatMessage>) => void;
  resetChat: () => void;
};

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [routine, setRoutine] = useState(initialRoutine);
  const [reminders, setReminders] = useState(initialReminders);
  const [consentOpen, setConsentOpen] = useState(true);
  const [consentChoice, setConsentChoice] = useState<"accepted" | "declined" | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({
    shareRoutine: true,
    shareCheckIns: true,
    medicationAlerts: true,
    voice: true,
    camera: true,
  });
  const [checkedIn, setCheckedIn] = useState(false);
  const [nurseNotified, setNurseNotified] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([greeting]);
  const nextId = useMemo(() => ({ n: 100 }), []);

  const addMessage = useCallback(
    (m: Omit<ChatMessage, "id">) => {
      const id = ++nextId.n;
      setMessages((cur) => [...cur, { ...m, id }]);
      return id;
    },
    [nextId],
  );

  const value: AppState = {
    routine,
    toggleRoutine: (id) => setRoutine((cur) => cur.map((r) => (r.id === id ? { ...r, done: !r.done } : r))),
    reminders,
    toggleReminder: (id) => setReminders((cur) => cur.map((r) => (r.id === id ? { ...r, done: !r.done } : r))),
    consentChoice,
    consentOpen,
    setConsentOpen,
    chooseConsent: (choice) => {
      setConsentChoice(choice);
      setConsentOpen(false);
      setPrefs((p) => ({ ...p, shareRoutine: choice === "accepted", shareCheckIns: choice === "accepted", medicationAlerts: choice === "accepted" }));
    },
    prefs,
    setPref: (key, v) => setPrefs((p) => ({ ...p, [key]: v })),
    checkedIn,
    setCheckedIn,
    nurseNotified,
    setNurseNotified,
    messages,
    addMessage,
    updateMessage: (id, patch) => setMessages((cur) => cur.map((m) => (m.id === id ? { ...m, ...patch } : m))),
    resetChat: () => {
      setMessages([greeting]);
      setNurseNotified(false);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}
