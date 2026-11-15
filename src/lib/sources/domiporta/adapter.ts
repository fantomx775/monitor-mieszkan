import { createPolicyBlockedAdapter } from "../policy-blocked";

export const domiportaAdapter = createPolicyBlockedAdapter(
  "domiporta",
  "Domiporta udostępnia RSS, ale przed automatycznym wykorzystaniem materiałów wymagana jest pisemna zgoda; feed pozostaje nieodczytywany.",
);
