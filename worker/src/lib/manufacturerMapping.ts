export function normalizeManufacturerKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function vendorClassMatchesItemClass(vendorClass: string, itemClass: string): boolean {
  const normalizedVendorClass = vendorClass.trim().toUpperCase();
  switch (itemClass.trim().toUpperCase()) {
    case "HARD-LOT":
      return normalizedVendorClass === "HARD";
    case "PLUMB-LOT":
      return normalizedVendorClass === "PLUMB";
    case "FIRE-RCVD":
      return normalizedVendorClass === "FIRE";
    case "APLS-RCVD":
      return !["HARD", "PLUMB", "FIRE", "PARTS"].includes(normalizedVendorClass);
    default:
      return false;
  }
}
