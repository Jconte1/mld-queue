# Vendor Rule Candidate Pass

Generated: 2026-08-24T16:12:13.688Z

## Summary

- Current review count: 771
- Active vendors considered eligible: 2437
- Candidate rules evaluated: 165
- Resolvable by HIGH rules: 0
- Potentially resolvable by business-rule approval: 203
- Remaining after HIGH only: 771
- Remaining after HIGH + business approval: 568

## Top Candidate Rules

| Token/Regex | Classification | Vendor | Review Items | Evidence | Reason |
| --- | --- | --- | ---: | --- | --- |
| `\bFAUCET\b` | AMBIGUOUS | BA0000008 Waterworks Operating Co., LLC | 96 | BA0000008 22; BA0000717 8; BA0000005 6 | Token FAUCET has multiple plausible vendors from existing StockItem evidence. |
| `\bBALANCE\b` | AMBIGUOUS | BA0000008 Waterworks Operating Co., LLC | 21 | BA0000008 35; BA0000005 8 | Token BALANCE has multiple plausible vendors from existing StockItem evidence. |
| `\bHENRY\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 21 | BA0000008 67 | Existing vendor-populated StockItems consistently map HENRY to BA0000008 in 67/67, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bMETAL\b` | AMBIGUOUS | BA0000008 Waterworks Operating Co., LLC | 19 | BA0000008 35; BA0000760 1; BA0000717 1 | Token METAL has multiple plausible vendors from existing StockItem evidence. |
| `\bMODERNE\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 18 | BA0000749 37; BA0003290 8; BA0000012 6 | Token MODERNE has multiple plausible vendors from existing StockItem evidence. |
| `\bICONA\b` | BUSINESS_RULE_APPROVAL | BA0010852 Fantini USA, Inc | 18 | BA0010852 23 | Existing vendor-populated StockItems consistently map ICONA to BA0010852 in 23/23, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bUNLACQUERED\b` | AMBIGUOUS | BA0000011 Emtek Products Group, LLC | 16 | BA0000011 35; BA0000007 15; BA0000643 14 | Token UNLACQUERED has multiple plausible vendors from existing StockItem evidence. |
| `\bSTREET\b` | AMBIGUOUS | BA0000006 California Faucets | 15 | BA0000006 45; BA0000700 34; BA0000804 1 | Token STREET has multiple plausible vendors from existing StockItem evidence. |
| `\bELONGATED\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 14 | BA0000749 16; BA0000008 13; BA0000536 12 | Token ELONGATED has multiple plausible vendors from existing StockItem evidence. |
| `\bGRAPHITE\b` | AMBIGUOUS | BA0000006 California Faucets | 13 | BA0000006 35; BA0000784 22; BA0000643 9 | Token GRAPHITE has multiple plausible vendors from existing StockItem evidence. |
| `\bONYX\b` | AMBIGUOUS | BA0000727 Graff Faucets Co. | 13 | BA0000727 35; BA0000714 10; BA0000722 5 | Token ONYX has multiple plausible vendors from existing StockItem evidence. |
| `\bPLUS\b` | AMBIGUOUS | BA0000770 Electrolux Consumer Products, Inc. | 13 | BA0000770 17; BA0000785 8; BA0000004 8 | Token PLUS has multiple plausible vendors from existing StockItem evidence. |
| `\bHARMONY\b` | AMBIGUOUS | BA0000001 BSH Home Appliances | 12 | BA0000001 22; BA0013051 12; BA0000708 1 | Token HARMONY has multiple plausible vendors from existing StockItem evidence. |
| `\bRANGE\b` | AMBIGUOUS | BA0000002 Roth Living | 12 | BA0000002 27; BA0000784 24; BA0000804 8 | Token RANGE has multiple plausible vendors from existing StockItem evidence. |
| `\bBIDET\b` | AMBIGUOUS | BA0000714 Delta Faucet Company | 11 | BA0000714 8; BA0000008 2; BA0003290 2 | Token BIDET has multiple plausible vendors from existing StockItem evidence. |
| `\bPURIST\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 11 | BA0000749 31; BA0000750 13; BA0000784 3 | Token PURIST has multiple plausible vendors from existing StockItem evidence. |
| `\bROMAN\b` | AMBIGUOUS | BA0000008 Waterworks Operating Co., LLC | 11 | BA0000008 18; BA0000006 13; BA0000743 4 | Token ROMAN has multiple plausible vendors from existing StockItem evidence. |
| `\bBRITISH\b` | BUSINESS_RULE_APPROVAL | BA0010852 Fantini USA, Inc | 11 | BA0010852 33 | Existing vendor-populated StockItems consistently map BRITISH to BA0010852 in 33/33, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bTOUCH\b` | BUSINESS_RULE_APPROVAL | BA0000784 Miele | 11 | BA0000784 87 | Existing vendor-populated StockItems consistently map TOUCH to BA0000784 in 87/87, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bPARDEES\b` | AMBIGUOUS | BA0000714 Delta Faucet Company | 10 | BA0000714 18; BA0000743 12 | Token PARDEES has multiple plausible vendors from existing StockItem evidence. |
| `\bPFISTER\b` | BUSINESS_RULE_APPROVAL | BA0015641 Pfister | 10 | BA0015641 86; BA0000676 5 | Token PFISTER directly matches an active Acumatica vendor and existing StockItems mostly map it to BA0015641 (86/91); review the minority vendor conflicts before approving automation. |
| `\bPROFILE\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 10 | BA0000008 40; BA0000673 1 | Existing vendor-populated StockItems consistently map PROFILE to BA0000008 in 40/41, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bRIVERUN\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 10 | BA0000008 36 | Existing vendor-populated StockItems consistently map RIVERUN to BA0000008 in 36/36, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bSTYLETHERM\b` | BUSINESS_RULE_APPROVAL | BA0000006 California Faucets | 10 | BA0000006 49 | Existing vendor-populated StockItems consistently map STYLETHERM to BA0000006 in 49/49, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bMULTI\b` | AMBIGUOUS | BA0000011 Emtek Products Group, LLC | 9 | BA0000011 85; BA0000712 4; BA0000670 1 | Token MULTI has multiple plausible vendors from existing StockItem evidence. |
| `\bTILE\b` | AMBIGUOUS | BA0000714 Delta Faucet Company | 9 | BA0000714 18; BA0000006 11; BA0000715 3 | Token TILE has multiple plausible vendors from existing StockItem evidence. |
| `\bDESCANSO\b` | BUSINESS_RULE_APPROVAL | BA0000006 California Faucets | 9 | BA0000006 81 | Existing vendor-populated StockItems consistently map DESCANSO to BA0000006 in 81/81, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bBRASSTECH\b` | AMBIGUOUS | BA0000743 Newport/Brasstech | 8 | BA0000743 16; BA0000714 9 | Token BRASSTECH has multiple plausible vendors from existing StockItem evidence. |
| `\bDISPENSER\b` | AMBIGUOUS | BA0000008 Waterworks Operating Co., LLC | 8 | BA0000008 17; BA0000714 14; BA0000715 13 | Token DISPENSER has multiple plausible vendors from existing StockItem evidence. |
| `\bPREP\b` | AMBIGUOUS | BA0000743 Newport/Brasstech | 8 | BA0000743 16; BA0000714 12; BA0000759 10 | Token PREP has multiple plausible vendors from existing StockItem evidence. |
| `\bSTRAINER\b` | AMBIGUOUS | BA0000714 Delta Faucet Company | 8 | BA0000714 14; BA0000008 10; BA0000007 9 | Token STRAINER has multiple plausible vendors from existing StockItem evidence. |
| `\bWASHBASIN\b` | AMBIGUOUS | BA0001129 GESSI North America | 8 | BA0001129 38; BA0010852 21 | Token WASHBASIN has multiple plausible vendors from existing StockItem evidence. |
| `\bADDSTORIS\b` | BUSINESS_RULE_APPROVAL | BA0000005 Hansgrohe | 8 | BA0000005 21 | Existing vendor-populated StockItems consistently map ADDSTORIS to BA0000005 in 21/21, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bETOILE\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 8 | BA0000008 20 | Existing vendor-populated StockItems consistently map ETOILE to BA0000008 in 20/20, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bFLYTE\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 8 | BA0000008 54 | Existing vendor-populated StockItems consistently map FLYTE to BA0000008 in 54/54, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bTARA\b` | BUSINESS_RULE_APPROVAL | BA0000715 Dornbracht GmbH & Co. KG | 8 | BA0000715 62; BA0000708 1 | Existing vendor-populated StockItems consistently map TARA to BA0000715 in 62/63, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bTHREE\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 8 | BA0000008 37 | Existing vendor-populated StockItems consistently map THREE to BA0000008 in 37/37, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `^TOTH` | NO_MATCH |   | 8 |  | No active vendor alias or consistent existing StockItem vendor evidence matched TOTH. |
| `\bANTHRACITE\b` | AMBIGUOUS | BA0015236 Blanco America Inc. | 7 | BA0015236 9; BA0000749 4; BA0000717 2 | Token ANTHRACITE has multiple plausible vendors from existing StockItem evidence. |
| `\bBATHTUB\b` | AMBIGUOUS | BA0000008 Waterworks Operating Co., LLC | 7 | BA0000008 13; BA0000007 11; BA0000711 9 | Token BATHTUB has multiple plausible vendors from existing StockItem evidence. |
| `\bCOLD\b` | AMBIGUOUS | BA0000759 Waterstone, LLC | 7 | BA0000759 29; BA0000008 9; BA0000714 7 | Token COLD has multiple plausible vendors from existing StockItem evidence. |
| `\bDECO\b` | AMBIGUOUS | BA0000011 Emtek Products Group, LLC | 7 | BA0000011 16; BA0010852 9; BA0000678 2 | Token DECO has multiple plausible vendors from existing StockItem evidence. |
| `\bFOUNDATIONS\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 7 | BA0000749 11; BA0011918 3 | Token FOUNDATIONS has multiple plausible vendors from existing StockItem evidence. |
| `\bKNURLED\b` | AMBIGUOUS | BA0000006 California Faucets | 7 | BA0000006 33; BA0000011 17; BA0016237 4 | Token KNURLED has multiple plausible vendors from existing StockItem evidence. |
| `\bOVEN\b` | AMBIGUOUS | BA0000784 Miele | 7 | BA0000784 71; BA0000002 4; BA0000001 1 | Token OVEN has multiple plausible vendors from existing StockItem evidence. |
| `\bSWITCH\b` | AMBIGUOUS | BA0000743 Newport/Brasstech | 7 | BA0000743 19; BA0000714 17; BA0000759 12 | Token SWITCH has multiple plausible vendors from existing StockItem evidence. |
| `\bTITANIUM\b` | AMBIGUOUS | BA0000760 Watermark | 7 | BA0000760 25; BA0000749 13; BA0000770 4 | Token TITANIUM has multiple plausible vendors from existing StockItem evidence. |
| `\bCHRONOS\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 7 | BA0000008 84 | Existing vendor-populated StockItems consistently map CHRONOS to BA0000008 in 84/84, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bDASH\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 7 | BA0000008 21; BA0016237 1 | Existing vendor-populated StockItems consistently map DASH to BA0000008 in 21/22, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bHENRY[\\s-]+CHRONOS\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 7 | BA0000008 84 | Existing vendor-populated StockItems consistently map HENRY CHRONOS to BA0000008 in 84/84, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bICONA[\\s-]+DECO\b` | BUSINESS_RULE_APPROVAL | BA0010852 Fantini USA, Inc | 7 | BA0010852 9 | Existing vendor-populated StockItems consistently map ICONA DECO to BA0010852 in 9/9, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bWORKS\b` | NO_MATCH |   | 7 |  | No active vendor alias or consistent existing StockItem vendor evidence matched WORKS. |
| `\bAIR[\\s-]+SWITCH\b` | AMBIGUOUS | BA0000759 Waterstone, LLC | 6 | BA0000759 41; BA0000714 11; BA0000715 9 | Token AIR SWITCH has multiple plausible vendors from existing StockItem evidence. |
| `\bASTOR\b` | AMBIGUOUS | BA0000714 Delta Faucet Company | 6 | BA0000714 14; BA0000664 3; BA0000743 2 | Token ASTOR has multiple plausible vendors from existing StockItem evidence. |
| `\bBEAUCLERE\b` | AMBIGUOUS | BA0000714 Delta Faucet Company | 6 | BA0000714 57; BA0000677 10 | Token BEAUCLERE has multiple plausible vendors from existing StockItem evidence. |
| `\bCASTIA\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 6 | BA0000749 18; BA0003290 6; BA0011918 3 | Token CASTIA has multiple plausible vendors from existing StockItem evidence. |
| `\bCITY\b` | AMBIGUOUS | BA0000686 Schaub & Company | 6 | BA0000686 2 | Token CITY has multiple plausible vendors from active vendor aliases. |
| `\bGLASS\b` | AMBIGUOUS | BA0000760 Watermark | 6 | BA0000760 20; BA0000008 17; BA0000670 10 | Token GLASS has multiple plausible vendors from existing StockItem evidence. |
| `\bHIGH\b` | AMBIGUOUS | BA0000008 Waterworks Operating Co., LLC | 6 | BA0000008 10; BA0000717 7; BA0000780 1 | Token HIGH has multiple plausible vendors from existing StockItem evidence. |
| `\bMCGEE\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 6 | BA0000749 25; BA0003290 6; BA0011918 5 | Token MCGEE has multiple plausible vendors from existing StockItem evidence. |
| `\bPOST\b` | AMBIGUOUS | BA0000006 California Faucets | 6 | BA0000006 22; BA0000011 20; BA0016237 16 | Token POST has multiple plausible vendors from existing StockItem evidence. |
| `\bSLIDE\b` | AMBIGUOUS | BA0000007 Rohl, LLC | 6 | BA0000007 14; BA0000743 12; BA0000673 7 | Token SLIDE has multiple plausible vendors from existing StockItem evidence. |
| `\bSOLID\b` | AMBIGUOUS | BA0000011 Emtek Products Group, LLC | 6 | BA0000011 20; BA0000002 15; BA0000653 10 | Token SOLID has multiple plausible vendors from existing StockItem evidence. |
| `\bSTUDIO\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 6 | BA0000749 24; BA0010334 23; BA0003290 6 | Token STUDIO has multiple plausible vendors from existing StockItem evidence. |
| `\bSTUDIO[\\s-]+MCGEE\b` | AMBIGUOUS | BA0000749 Standard Plumbing Supply | 6 | BA0000749 25; BA0003290 6; BA0011918 5 | Token STUDIO MCGEE has multiple plausible vendors from existing StockItem evidence. |
| `\bTANK\b` | AMBIGUOUS | BA0000733 Jaclo | 6 | BA0000733 23; BA0000714 15; BA0000743 7 | Token TANK has multiple plausible vendors from existing StockItem evidence. |
| `\bWORKSTATION\b` | AMBIGUOUS | BA0000724 The Galley | 6 | BA0000724 29; BA0000749 7; BA0000007 6 | Token WORKSTATION has multiple plausible vendors from existing StockItem evidence. |
| `\bLUDLOW\b` | BUSINESS_RULE_APPROVAL | BA0000008 Waterworks Operating Co., LLC | 6 | BA0000008 56 | Existing vendor-populated StockItems consistently map LUDLOW to BA0000008 in 56/56, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bSIZABLE\b` | BUSINESS_RULE_APPROVAL | BA0000731 Infinity Drain | 6 | BA0000731 29 | Existing vendor-populated StockItems consistently map SIZABLE to BA0000731 in 29/29, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `\bTERRA\b` | BUSINESS_RULE_APPROVAL | BA0000006 California Faucets | 6 | BA0000006 67 | Existing vendor-populated StockItems consistently map TERRA to BA0000006 in 67/67, but the vendor name does not directly contain the token; approve as brand/distributor rule before automation. |
| `^4176` | NO_MATCH |   | 6 |  | No active vendor alias or consistent existing StockItem vendor evidence matched 4176. |
| `\bFORME\b` | NO_MATCH |   | 6 | BA0013229 2 | No active vendor alias or consistent existing StockItem vendor evidence matched FORME. |
| `^TOPB` | NO_MATCH |   | 6 |  | No active vendor alias or consistent existing StockItem vendor evidence matched TOPB. |
| `^TOTH2` | NO_MATCH |   | 6 |  | No active vendor alias or consistent existing StockItem vendor evidence matched TOTH2. |
| `^0104` | AMBIGUOUS | BA0014832 Zip Water | 5 | BA0014832 3; BA0000008 1 | Token 0104 has multiple plausible vendors from existing StockItem evidence. |
| `^1200` | AMBIGUOUS | BA0000743 Newport/Brasstech | 5 | BA0000743 8; BA0000759 7; BA0000649 5 | Token 1200 has multiple plausible vendors from existing StockItem evidence. |
| `\bBRIDGE\b` | AMBIGUOUS | BA0000714 Delta Faucet Company | 5 | BA0000714 16; BA0000008 13; BA0000743 8 | Token BRIDGE has multiple plausible vendors from existing StockItem evidence. |
| `\bBUILT\b` | AMBIGUOUS | BA0000760 Watermark | 5 | BA0000760 32; BA0000784 21; BA0000004 7 | Token BUILT has multiple plausible vendors from existing StockItem evidence. |
| `\bCLOSE\b` | AMBIGUOUS | BA0016237 Phylrich | 5 | BA0016237 14; BA0000663 9; BA0000717 6 | Token CLOSE has multiple plausible vendors from existing StockItem evidence. |
| `\bCONCRETE\b` | AMBIGUOUS | BA0000736 Lacava LLC | 5 | BA0000736 15; BA0000741 4; BA0000738 3 | Token CONCRETE has multiple plausible vendors from existing StockItem evidence. |

## Notes

- `HIGH` means the rule is strong enough to consider for automatic assignment, subject to explicit approval before mutation work.
- `BUSINESS_RULE_APPROVAL` means existing StockItem data is consistent, but the token is a brand/product-line/distributor relationship that should be explicitly approved.
- `AMBIGUOUS` means multiple active vendors or StockItem evidence conflicts; do not auto-assign.
- All evidence came from read-only StockItem GETs with `VendorDetails` expanded and the existing vendor master artifact.
