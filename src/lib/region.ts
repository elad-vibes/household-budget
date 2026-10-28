// The household's region in the running app (0016, DECISIONS #42). A module-level value like the rest of
// the formatting helpers: data.ts sets it when the household's settings load, and everything that prints an
// amount, picks a bank list or hides an Israeli-only feature reads it from here. Default IL = pre-0016.
import { regionOf, type Region, type RegionInfo } from "../../supabase/functions/_shared/region.ts";
export { REGIONS, REGION_CODES, isRegion, regionOf, type Region, type RegionInfo } from "../../supabase/functions/_shared/region.ts";

let current: RegionInfo = regionOf("IL");

export const setRegion = (code: unknown): void => { current = regionOf(code); };
export const region = (): RegionInfo => current;
export const regionCode = (): Region => current.code;
/** ISO code of the base currency ("ILS" / "THB"): transactions.amount is always in it. */
export const baseCode = (): string => current.currency;
/** "₪" / "฿" */
export const baseSymbol = (): string => current.symbol;
const WORDS = { ILS: { plain: "שקלים", to: "לשקלים", label: "₪ שקל" }, THB: { plain: "באט", to: "לבאט", label: "฿ באט" } } as const;
/** "שקלים" / "באט" */
export const baseWord = (): string => WORDS[current.currency].plain;
/** "לשקלים" / "לבאט" — "converted to …" */
export const baseWordTo = (): string => WORDS[current.currency].to;
/** "₪ שקל" / "฿ באט" — the toggle label on the add form */
export const baseLabel = (): string => WORDS[current.currency].label;
