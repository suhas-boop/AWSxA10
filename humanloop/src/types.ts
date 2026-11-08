export type IconName =
  | "arrow-left"
  | "bell"
  | "camera"
  | "check"
  | "clock"
  | "heart"
  | "home"
  | "mic"
  | "pill"
  | "send"
  | "shield"
  | "sparkle"
  | "stop"
  | "user"
  | "water"
  | "walk";

export type ChatMessage = {
  id: number;
  sender: "nurse" | "alice";
  text: string;
  image?: string;
  note?: string;
};

export type NurseAlert = {
  id: string;
  createdAt: string;
  patient: string;
  status: "new" | "acknowledged";
  urgency: "routine" | "high" | "urgent" | string;
  reason: string;
  summary: string;
  requestedAction: string;
  photoDescription: string | null;
  transcript: string[];
};
