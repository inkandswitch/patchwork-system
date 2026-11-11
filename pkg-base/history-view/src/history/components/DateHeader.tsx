export interface DateHeaderProps {
  date: Date;
}

/**
 * Component to display a date header in the timeline
 * Groups history items by day
 */
export function DateHeader(props: DateHeaderProps) {
  const dayOfWeek = () => {
    return props.date.toLocaleDateString(undefined, { weekday: "long" });
  };

  const formattedDate = () => {
    return props.date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  // Check if this date is today
  const isToday = () => {
    const today = new Date();
    return (
      props.date.getDate() === today.getDate() &&
      props.date.getMonth() === today.getMonth() &&
      props.date.getFullYear() === today.getFullYear()
    );
  };

  // Check if this date is yesterday
  const isYesterday = () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return (
      props.date.getDate() === yesterday.getDate() &&
      props.date.getMonth() === yesterday.getMonth() &&
      props.date.getFullYear() === yesterday.getFullYear()
    );
  };

  const displayDay = () => {
    if (isToday()) return "Today";
    if (isYesterday()) return "Yesterday";
    return dayOfWeek();
  };

  return (
    <div class="history-date-header">
      {displayDay()}, {formattedDate()}
    </div>
  );
}
