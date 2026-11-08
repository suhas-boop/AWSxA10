import { Icon } from "./Icon";
import { useApp } from "../state";

export function RoutineSection() {
  const { routine, toggleRoutine } = useApp();
  const completed = routine.filter((r) => r.done).length;
  return (
    <section className="content-section" id="routine" aria-labelledby="routine-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">TODAY</p>
          <h2 id="routine-title">My routine</h2>
        </div>
        <div className="progress-pill">
          <strong>
            {completed}/{routine.length}
          </strong>{" "}
          complete
        </div>
      </div>
      <div className="routine-grid">
        {routine.map((item) => (
          <article className={`routine-card ${item.color} ${item.done ? "is-done" : ""}`} key={item.id}>
            <div className="routine-icon">
              <Icon name={item.icon} size={28} />
            </div>
            <div className="routine-copy">
              <span className="routine-time">
                <Icon name="clock" size={15} /> {item.time}
              </span>
              <h3>{item.title}</h3>
              <p>{item.note}</p>
            </div>
            <button
              className="complete-button"
              type="button"
              aria-label={`${item.done ? "Mark incomplete" : "Mark complete"}: ${item.title}`}
              aria-pressed={item.done}
              onClick={() => toggleRoutine(item.id)}
            >
              <Icon name="check" size={22} />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

export function RemindersSection({ showCareNote = true }: { showCareNote?: boolean }) {
  const { reminders, toggleReminder } = useApp();
  return (
    <section className="content-section reminders-section" id="reminders" aria-labelledby="reminders-title">
      <div className="section-heading">
        <div>
          <p className="section-kicker">COMING UP</p>
          <h2 id="reminders-title">Reminders</h2>
        </div>
      </div>
      <div className="reminder-stack">
        {reminders.map((r) => (
          <div className={`reminder-panel ${r.done ? "is-done" : ""}`} key={r.id}>
            <div className="reminder-date">
              <strong>{r.when}</strong>
              <span>{r.period}</span>
            </div>
            <div className="reminder-symbol">
              <Icon name={r.icon} size={26} />
            </div>
            <div className="reminder-copy">
              <span>{r.day}</span>
              <h3>{r.title}</h3>
              <p>{r.note}</p>
            </div>
            <button className="reminder-action" type="button" onClick={() => toggleReminder(r.id)}>
              {r.done ? "Done ✓" : "I’ll do it"}
            </button>
          </div>
        ))}
      </div>
      {showCareNote && (
        <div className="care-note">
          <Icon name="shield" size={28} />
          <div>
            <strong>Your care circle is connected</strong>
            <span>Dr. Miller can see your completed health updates.</span>
          </div>
        </div>
      )}
    </section>
  );
}
