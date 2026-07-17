import { buildDeliveryConfirmationAttributesDryRunResult } from "../src/lib/deliveryConfirmationAttributes";

function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertThrows(fn: () => unknown, label: string) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${label}: expected function to throw`);
}

const result = buildDeliveryConfirmationAttributesDryRunResult({
  orderType: "so",
  orderNumber: "so40466",
  confirmedVia: "WEBPAGE",
  confirmedWith: "Trae Customer",
  deliveryConfirmationId: "dc_123",
  deliveryGroupId: "dg_123",
  deliveryDate: "2026-07-22",
  source: "WEBPAGE",
  dryRun: true,
});

assertEqual(result.wouldWrite, true, "wouldWrite");
assertEqual(result.dryRun, true, "dryRun");
assertEqual(result.skippedLiveWrite, true, "skippedLiveWrite");
assertEqual(result.orderType, "SO", "orderType normalized");
assertEqual(result.orderNumber, "SO40466", "orderNumber normalized");
assertEqual(result.fields["Document.AttributeCONFIRMVIA"], "WEBPAGE", "CONFIRMVIA value");
assertEqual(result.fields["Document.AttributeCONFIRMWTH"], "Trae Customer", "CONFIRMWTH value");
assertEqual(
  result.acumaticaPayload.custom.Document.AttributeCONFIRMVIA.value,
  "WEBPAGE",
  "Acumatica payload CONFIRMVIA"
);
assertEqual(
  result.acumaticaPayload.custom.Document.AttributeCONFIRMWTH.value,
  "Trae Customer",
  "Acumatica payload CONFIRMWTH"
);

assertThrows(
  () =>
    buildDeliveryConfirmationAttributesDryRunResult({
      orderType: "SO",
      orderNumber: "SO40466",
      confirmedVia: "WEBPAGE",
      confirmedWith: "Trae Customer",
      deliveryConfirmationId: "dc_123",
      deliveryGroupId: "dg_123",
      deliveryDate: "2026-07-22",
      source: "WEBPAGE",
      dryRun: false,
    }),
  "dryRun false"
);

console.log(JSON.stringify(result, null, 2));
