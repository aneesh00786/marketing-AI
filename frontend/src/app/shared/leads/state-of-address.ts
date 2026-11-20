/**
 * The state / union territory named in a lead's address (India), e.g. "…, Pune, Maharashtra 411042" → Maharashtra.
 * Leads have no separate state field, so it is read from the address text; null when none is found.
 */
const STATES: [string, RegExp][] = [
  ['Andaman and Nicobar Islands', /andaman/i], ['Andhra Pradesh', /andhra\s*pradesh/i], ['Arunachal Pradesh', /arunachal/i],
  ['Assam', /\bassam\b/i], ['Bihar', /\bbihar\b/i], ['Chandigarh', /chandigarh/i], ['Chhattisgarh', /chhattisgarh|chattisgarh/i],
  ['Dadra and Nagar Haveli and Daman and Diu', /dadra|nagar\s*haveli|\bdaman\b|\bdiu\b/i], ['Delhi', /\bdelhi\b/i], ['Goa', /\bgoa\b/i],
  ['Gujarat', /gujarat/i], ['Haryana', /haryana/i], ['Himachal Pradesh', /himachal/i], ['Jammu and Kashmir', /jammu|kashmir/i],
  ['Jharkhand', /jharkhand/i], ['Karnataka', /karnataka/i], ['Kerala', /kerala/i], ['Ladakh', /ladakh/i], ['Lakshadweep', /lakshadweep/i],
  ['Madhya Pradesh', /madhya\s*pradesh/i], ['Maharashtra', /maharashtra/i], ['Manipur', /manipur/i], ['Meghalaya', /meghalaya/i],
  ['Mizoram', /mizoram/i], ['Nagaland', /nagaland/i], ['Odisha', /odisha|orissa/i], ['Puducherry', /puducherry|pondicherry/i],
  ['Punjab', /punjab/i], ['Rajasthan', /rajasthan/i], ['Sikkim', /sikkim/i], ['Tamil Nadu', /tamil\s*nadu/i], ['Telangana', /telangana/i],
  ['Tripura', /tripura/i], ['Uttar Pradesh', /uttar\s*pradesh/i], ['Uttarakhand', /uttarakhand|uttaranchal/i], ['West Bengal', /west\s*bengal/i]
];

export function stateOfAddress(address: string | null | undefined): string | null {
  const a = String(address || '');
  if (!a) return null;
  // The last state named wins (addresses end with "State PIN"; a street can be named after another state).
  let best: { name: string; at: number } | null = null;
  for (const [name, re] of STATES) {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(a))) if (!best || m.index > best.at) best = { name, at: m.index };
  }
  return best?.name || null;
}
