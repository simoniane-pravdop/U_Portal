/** A later forecast extends the deadline; an earlier one never shortens it. */
export function plannedEndForForecast(plannedEnd: string, forecastEnd: string): string {
  return forecastEnd && (!plannedEnd || forecastEnd > plannedEnd) ? forecastEnd : plannedEnd;
}
