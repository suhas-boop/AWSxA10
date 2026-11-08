// Recognize a bounded set of explicit refusals in finalized assistant speech.
// This is activity-feed annotation only, never an access-control decision.
// Return fixed labels: do not put transcript excerpts, names or medical content in the log.
export function responseBoundary(text) {
  const value = String(text).toLowerCase().replaceAll('’', "'");
  if (!/\b(?:i|we)\s+(?:(?:am|are)\s+)?(?:can't|cannot|can not|won't|will not|don't|do not|unable|not able|not allowed|not permitted|not authorized)\b/.test(value)) return null;
  if (/\b(?:staff privileges|admin(?:istrator)? (?:access|privileges)|change (?:your|a) role)\b/.test(value)) return { kind: 'staff-role', action: 'Declined a request for staff privileges' };
  if (/\bcamera\b/.test(value)) return { kind: 'camera', action: 'Declined a camera-access request' };
  if (/\b(?:change|adjust|prescribe|recommend)\b/.test(value) && /\b(?:medication|medicine|dose|treatment)\b/.test(value)) return { kind: 'treatment', action: 'Declined a treatment-change request' };
  if (/\b(?:share|provide|access|read|disclose|discuss|give)\b/.test(value) && /\b(?:private|medical|health|records?|diagnos(?:is|es)|conditions?)\b/.test(value)) return { kind: 'private-information', action: 'Declined a private-information request' };
  if (/\battendance\b/.test(value) && /\b(?:disabled|turned off|permission|privacy|shared|allowed)\b/.test(value)) return { kind: 'attendance', action: 'Declined an attendance-information request' };
  return null;
}
