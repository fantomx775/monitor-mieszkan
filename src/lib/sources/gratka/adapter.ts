import { createPolicyBlockedAdapter } from "../policy-blocked";

export const gratkaAdapter = createPolicyBlockedAdapter(
  "gratka",
  "Automatyczne utrwalanie danych wymaga potwierdzenia uprawnień według regulaminu Gratka; do tego czasu nie wysyłamy żądań.",
);
