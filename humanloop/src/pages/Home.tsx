import { Icon } from "../components/Icon";
import { Bot } from "../components/Bot";
import { RemindersSection, RoutineSection } from "../components/Sections";
import { useApp } from "../state";
import { navigate } from "../lib/router";

const days = [
  { day: "Mon", date: "21", done: true },
  { day: "Tue", date: "22", done: true },
  { day: "Wed", date: "23", done: true },
  { day: "Thu", date: "24", current: true },
  { day: "Fri", date: "25" },
  { day: "Sat", date: "26" },
];

export default function Home() {
  const { checkedIn } = useApp();
  return (
    <>
      <section className="hero" aria-labelledby="welcome-title">
        <div>
          <p className="eyebrow">
            <Icon name="sparkle" size={18} /> Thursday, 24 October
          </p>
          <h1 id="welcome-title">Good morning, Alice!</h1>
        </div>
        <div className="wellbeing-card">
          <Bot className="card-bot" />
          <div>
            <span>Today’s check-in</span>
            <strong>How are you feeling?</strong>
          </div>
          <button className={checkedIn ? "check-in-complete" : ""} type="button" onClick={() => navigate("/chat2")}>
            {checkedIn ? "Checked in today ✓" : "Check in"}
          </button>
        </div>
      </section>

      <section className="date-strip" aria-label="This week">
        {days.map((item) => (
          <div className={`day-card ${item.current ? "current" : ""} ${item.done ? "done" : ""}`} key={item.day}>
            <span>{item.date}</span>
            <small>{item.day}</small>
            {item.done && (
              <i>
                <Icon name="check" size={12} />
              </i>
            )}
          </div>
        ))}
      </section>

      <RoutineSection />
      <RemindersSection />
    </>
  );
}
