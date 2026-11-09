/**
 * Phone numbers typed in by hand are saved with their country code ("+61 412 345 678"), so a
 * number means the same thing in every country and can be dialled. 7 to 15 digits (E.164).
 * Imported files and data found by Lead Discovery are not checked here.
 */
const PHONE_MESSAGE = 'Enter the phone number with its country code, like +61 412 345 678.';

function phoneProblem(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (!/^\+[1-9][\d\s().-]*$/.test(v)) return PHONE_MESSAGE;
  const digits = v.replace(/\D/g, '').length;
  if (digits < 7 || digits > 15) return 'Enter a complete phone number with its country code.';
  return null;
}

/** For zod: .refine(v => !phoneProblem(v), { message }) on an optional phone string. */
const phoneRefine = [v => !phoneProblem(v), { message: PHONE_MESSAGE }];

module.exports = { phoneProblem, phoneRefine, PHONE_MESSAGE };
