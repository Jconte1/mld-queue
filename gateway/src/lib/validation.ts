import { z } from "zod";
import { env } from "@/lib/env";

type BodyResult<T> = { parsed: T; raw: string };

const valueString = z.string().min(1).max(env.maxStringLength);
const wrappedString = z.object({ value: valueString }).strict();
const wrappedNumber = z.object({ value: z.number() }).strict();
const wrappedBoolean = z.object({ value: z.boolean() }).strict();

const createProductsItemSchema = z
  .object({
    InventoryID: wrappedString,
    Quantity: wrappedNumber.optional(),
    UOM: wrappedString.optional()
  })
  .strict();

const updateProductsItemSchema = z
  .object({
    id: z.string().min(1).max(env.maxStringLength).optional(),
    OpportunityProductID: wrappedNumber.optional(),
    InventoryID: wrappedString.optional(),
    Qty: wrappedNumber.optional(),
    Quantity: wrappedNumber.optional(),
    UOM: wrappedString.optional(),
    Warehouse: wrappedString.optional(),
    delete: z.boolean().optional()
  })
  .strict()
  .refine(
    (item) => {
      if (item.delete) {
        return Boolean(item.id || item.OpportunityProductID || item.InventoryID);
      }

      return (
        Object.keys(item).length > 0 &&
        Boolean(item.id || item.InventoryID || item.OpportunityProductID)
      );
    },
    "Each product update must include id, OpportunityProductID, or InventoryID"
  );

const createOpportunitySchema = z
  .object({
    Subject: wrappedString.optional(),
    ClassID: wrappedString.optional(),
    BusinessAccount: wrappedString.optional(),
    Location: wrappedString.optional(),
    Owner: wrappedString.optional(),
    Products: z.array(createProductsItemSchema).min(1),
    ContactInformation: z
      .object({
        FirstName: wrappedString.optional(),
        LastName: wrappedString.optional(),
        CompanyName: wrappedString.optional(),
        Email: wrappedString.optional(),
        Phone1: wrappedString.optional()
      })
      .strict()
      .optional(),
    Address: z
      .object({
        AddressLine1: wrappedString.optional(),
        AddressLine2: wrappedString.optional(),
        City: wrappedString.optional(),
        State: wrappedString.optional(),
        PostalCode: wrappedString.optional(),
        Country: wrappedString.optional()
      })
      .strict()
      .optional(),
    Hold: wrappedBoolean.optional()
  })
  .strict();

const updateOpportunitySchema = createOpportunitySchema
  .omit({ Products: true })
  .extend({
    Products: z.array(updateProductsItemSchema).min(1).optional()
  })
  .partial()
  .refine((val) => Object.keys(val).length > 0, "At least one field is required for update");

export async function parseJsonBodyWithLimit<T>(req: Request, schema: z.Schema<T>): Promise<BodyResult<T>> {
  const raw = await req.text();
  const bytes = Buffer.byteLength(raw, "utf8");

  if (bytes > env.maxRequestBytes) {
    throw new Response(JSON.stringify({ error: "Payload too large" }), {
      status: 413,
      headers: { "content-type": "application/json" }
    });
  }

  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Response(
      JSON.stringify({
        error: "Validation failed",
        issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" }
      }
    );
  }

  return { parsed: result.data, raw };
}

export { createOpportunitySchema, updateOpportunitySchema };
