import ExcelJS from "exceljs";
import { validateCustomerStateCorrectionInput, type CustomerStateCorrectionInput } from "../../src/lib/customerStateCorrection";

export type CustomerStateWorkbookRow = CustomerStateCorrectionInput & { sourceRow: number };
const HEADERS = ["Customer ID", "EXPECTED STATE", "State", "Country", "Address Line 1", "Address Line 2", "City", "Postal Code"];

export async function readCustomerStateWorkbook(file: string, sheet = "Data"): Promise<CustomerStateWorkbookRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const worksheet = workbook.getWorksheet(sheet);
  if (!worksheet) throw new Error(`Worksheet not found: ${sheet}`);
  const columns = new Map<string, number>();
  worksheet.getRow(1).eachCell((cell, column) => {
    const name = cell.text.trim().toUpperCase();
    if (columns.has(name)) throw new Error(`Duplicate header: ${name}`);
    columns.set(name, column);
  });
  for (const name of HEADERS) if (!columns.has(name.toUpperCase())) throw new Error(`Missing header: ${name}`);
  const result: CustomerStateWorkbookRow[] = [];
  const customers = new Set<string>();
  worksheet.eachRow((row, number) => {
    if (number === 1 || !row.hasValues) return;
    const value = (name: string) => {
      const raw = row.getCell(columns.get(name.toUpperCase())!).value;
      if (raw === null || raw === undefined) return "";
      // Formulas, hyperlinks, and rich objects are not executable or trusted input.
      if (typeof raw !== "string" && typeof raw !== "number") throw new Error(`Row ${number}: unsupported cell type in ${name}`);
      return String(raw).trim();
    };
    if (HEADERS.every(name => value(name) === "")) return;
    let input: CustomerStateCorrectionInput;
    try {
      input = validateCustomerStateCorrectionInput({ customerId: value("Customer ID"), originalState: value("State"),
        expectedState: value("EXPECTED STATE"), apply: false,
        address: { Country: value("Country"), AddressLine1: value("Address Line 1"), AddressLine2: value("Address Line 2"),
          City: value("City"), PostalCode: value("Postal Code") } });
    } catch (error) { throw new Error(`Row ${number}: ${error instanceof Error ? error.message : "invalid row"}`); }
    if (customers.has(input.customerId)) throw new Error(`Row ${number}: duplicate Customer ID ${input.customerId}`);
    customers.add(input.customerId);
    result.push({ ...input, sourceRow: number });
  });
  if (!result.length) throw new Error("No customer rows found");
  return result;
}
