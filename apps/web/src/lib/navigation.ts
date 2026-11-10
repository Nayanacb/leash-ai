/** Full-page navigation to another site (PayPal). Wrapped so tests can observe it. */
export function leaveForExternalPage(url: string) {
  window.location.assign(url);
}
