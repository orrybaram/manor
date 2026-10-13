/** A greeting for the local hour: "Good morning" until noon, and so on. */
export function greeting(at: number): string {
  const hour = new Date(at).getHours();
  if (hour < 5) return "Burning the midnight oil";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Working late";
}
