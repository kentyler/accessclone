# Qualifying Analysis: northwinddev

**Source:** C:\Users\Ken\Desktop\cloneexamples\northwinddev.accdb
**File size:** 14.2 MB
**Analyzed:** 2026-03-14 15:32
**Duration:** 53.8s

---

## Summary

| Category | Count |
|----------|-------|
| Tables | 28 |
| Queries | 65 |
| Forms | 40 |
| Reports | 15 |
| VBA Modules | 66 |
| Macros | 11 |
| Relationships | 27 |
| Total data rows | 613 |

### Findings

| Severity | Count |
|----------|-------|
| Errors (must fix before migration) | 0 |
| Warnings (review recommended) | 0 |
| Info (noted, usually handled automatically) | 18 |

---

## Tables

| Table | Fields | Rows | Primary Key |
|-------|--------|------|-------------|
| Catalog_TableOfContents | 2 | 16 | Yes |
| Companies | 15 | 13 | Yes |
| CompanyTypes | 6 | 4 | Yes |
| Contacts | 13 | 6 | Yes |
| EmployeePrivileges | 7 | 3 | Yes |
| Employees | 16 | 11 | Yes |
| Learn | 3 | 15 | Yes |
| MRU | 5 | 0 | Yes |
| NorthwindFeatures | 7 | 39 | Yes |
| OrderDetails | 11 | 131 | Yes |
| OrderDetailStatus | 7 | 6 | Yes |
| Orders | 18 | 52 | Yes |
| OrderStatus | 8 | 5 | Yes |
| Privileges | 6 | 1 | Yes |
| ProductCategories | 9 | 16 | Yes |
| Products | 16 | 43 | Yes |
| ProductVendors | 7 | 47 | Yes |
| PurchaseOrderDetails | 10 | 43 | Yes |
| PurchaseOrders | 18 | 2 | Yes |
| PurchaseOrderStatus | 7 | 5 | Yes |
| States | 2 | 51 | Yes |
| StockTake | 9 | 43 | Yes |
| Strings | 6 | 49 | Yes |
| SystemSettings | 4 | 5 | Yes |
| TaxStatus | 6 | 2 | Yes |
| Titles | 5 | 3 | Yes |
| UserSettings | 4 | 1 | Yes |
| Welcome | 4 | 1 | Yes |

---

## Queries

| Query | Type |
|-------|------|
| qrycboCompanyType | Select |
| qrycboCustomers | Select |
| qrycboEmployees | Select |
| qrycboOrderDetailStatus | Select |
| qrycboOrderStatus | Select |
| qrycboProductCategories | Union |
| qrycboProductCategory | Select |
| qrycboProducts | Select |
| qrycboProducts_All | Select |
| qrycboProducts_PO | Select |
| qrycboShippers | Select |
| qrycboStates | Select |
| qrycboTaxStatus | Select |
| qrycboVendors | Select |
| qryCompanies | Select |
| qryCompanyList | Select |
| qryContacts | Select |
| qryCustomerOrderList | Select |
| qryCustomers | Select |
| qryEmployeeLogin | Select |
| qryEmployeePrivileges | Select |
| qryEmployees | Select |
| qryEmployeeSupervisor | Select |
| qryInvoice | Select |
| qryMaxStockTakeDate | Select |
| qryMRU | Select |
| qryOrder | Select |
| qryOrderLineItems | Select |
| qryOrderList | Select |
| qryOrderList_DetailStatus | Select |
| qryOrderList_DetailStatus_Lowest | Select |
| qryOrders_MostRecent | Select |
| qryOrders_MostRecent_Customer | Select |
| qryOrders_MostRecent_Employee | Select |
| qryOrders_MostRecent_ModifiedOn | Select |
| qryOrderTotal | Select |
| qryPOProducts_ByStatus | Select |
| qryPrivileges | Select |
| qryProductCategories | Select |
| qryProductDetail | Select |
| qryProductList | Select |
| qryProductList_Export | Select |
| qryProductOrders | Select |
| qryProductPurchaseOrder | Select |
| qryProductVendors | Select |
| qryPurchaseOrder | Select |
| qryPurchaseOrderCost | Select |
| qryPurchaseOrderLineItems | Select |
| qryPurchaseOrderList | Select |
| qryrptEmployeeEmailList | Select |
| qryrptEmployeePhoneList | Select |
| qryrptProductCatalog | Select |
| qryrptSalesByEmployee | Select |
| qryrptSalesByProduct_ByMonth | Select |
| qryrptSalesByProduct_ByQuarter | Select |
| qrySales_SalesRep | Select |
| qryShipperOrderList | Select |
| qryShippers | Select |
| qryStockTake | Select |
| qryStrings | Select |
| qrySystemSettings | Select |
| qryTitle | Select |
| qryTotalSalesByProduct | Select |
| qryVendorPurchaseOrderList | Select |
| qryVendors | Select |

---

## Forms

| Form | Record Source | Controls | Events | Subforms | Combos |
|------|--------------|----------|--------|----------|--------|
| _Design | (unbound) | 29 | 0 | 4 | 1 |
| frmAbout | (unbound) | 11 | 1 | 0 | 0 |
| frmAdmin | (unbound) | 25 | 9 | 1 | 0 |
| frmCompanyDetail | qryCompanies | 42 | 15 | 2 | 3 |
| frmCompanyList | qryCompanyList | 54 | 7 | 0 | 0 |
| frmCredentials | qryEmployeeLogin | 20 | 4 | 0 | 0 |
| frmEmployeeList | qryEmployees | 33 | 6 | 1 | 2 |
| frmEmployeeTitles | Titles | 4 | 1 | 0 | 0 |
| frmGenericDialog | (unbound) | 7 | 3 | 0 | 0 |
| frmLearn | (unbound) | 15 | 0 | 0 | 0 |
| frmLogin | (unbound) | 14 | 3 | 0 | 1 |
| frmNorthwindFeatures | NorthwindFeatures | 15 | 1 | 0 | 0 |
| frmOrderDetails | qryOrder | 49 | 16 | 1 | 5 |
| frmOrderList | qryOrderList | 38 | 5 | 0 | 0 |
| frmProductDetail | qryProductDetail | 58 | 17 | 4 | 2 |
| frmProductList | qryProductList | 28 | 3 | 0 | 0 |
| frmPurchaseOrderDetails | qryPurchaseOrder | 49 | 15 | 1 | 2 |
| frmPurchaseOrderList | qryPurchaseOrderList | 27 | 3 | 0 | 0 |
| frmReports | (unbound) | 24 | 9 | 0 | 0 |
| frmSelectVendorDialog | (unbound) | 9 | 3 | 0 | 1 |
| frmStartup | (unbound) | 9 | 0 | 0 | 0 |
| frmWelcome | Welcome | 15 | 3 | 0 | 0 |
| sfrmAdmin_DeleteTestData | (unbound) | 4 | 1 | 0 | 0 |
| sfrmAdmin_InternetOrders | qrySystemSettings | 7 | 2 | 0 | 0 |
| sfrmAdmin_ResetDates | qrySystemSettings | 4 | 1 | 0 | 0 |
| sfrmAdmin_Strings | qryStrings | 7 | 0 | 0 | 0 |
| sfrmAdmin_SystemSettings | qrySystemSettings | 11 | 0 | 0 | 0 |
| sfrmCompanyDetail_Contacts | qryContacts | 24 | 4 | 0 | 0 |
| sfrmCompanyDetail_CustomerOrders | qryCustomerOrderList | 14 | 0 | 0 | 0 |
| sfrmCompanyDetail_ShipperOrders | qryShipperOrderList | 14 | 0 | 0 | 0 |
| sfrmCompanyDetail_VendorPurchaseOrders | qryVendorPurchaseOrderList | 16 | 0 | 0 | 0 |
| sfrmEmployee_Privileges | qryEmployeePrivileges | 9 | 1 | 0 | 2 |
| sfrmOrderLineItems | qryOrderLineItems | 22 | 6 | 0 | 3 |
| sfrmOrders_MostRecent_ByEmployee | qryOrders_MostRecent | 13 | 1 | 0 | 0 |
| sfrmProductCategories | qryProductCategories | 41 | 5 | 0 | 1 |
| sfrmProductDetail_Orders | qryProductOrders | 15 | 1 | 0 | 0 |
| sfrmProductDetail_PurchaseOrders | qryProductPurchaseOrder | 18 | 1 | 0 | 0 |
| sfrmProductDetail_StockTake | qryStockTake | 10 | 5 | 0 | 0 |
| sfrmProductDetail_Vendors | qryProductVendors | 10 | 2 | 0 | 1 |
| sfrmPurchaseOrderLineItems | qryPurchaseOrderLineItems | 13 | 4 | 0 | 1 |

---

## Reports
- _Design
- rptEmployeeEmailList
- rptEmployeePhoneList
- rptInvoice
- rptLearn
- rptProductCatalog
- rptRelationshipsWindow
- rptSalesByEmployee
- rptSalesByProduct
- rptSalesByProductQuarterly
- srptCatalog_TableOfContents
- srptGastronomic
- srptOrderForm
- srptQuality
- srptShipVia

---

## VBA Modules

| Module | Type | Lines | External Dependencies |
|--------|------|-------|-----------------------|
| clsErrorHandler | Class | 140 | None |
| Form__Design | Form/Report | 2 | None |
| Form_frmAbout | Form/Report | 15 | None |
| Form_frmAdmin | Form/Report | 201 | None |
| Form_frmCompanyDetail | Form/Report | 713 | None |
| Form_frmCompanyList | Form/Report | 233 | None |
| Form_frmCredentials | Form/Report | 88 | None |
| Form_frmEmployeeList | Form/Report | 283 | None |
| Form_frmEmployeeTitles | Form/Report | 20 | None |
| Form_frmGenericDialog | Form/Report | 119 | None |
| Form_frmLogin | Form/Report | 114 | None |
| Form_frmNorthwindFeatures | Form/Report | 36 | None |
| Form_frmOrderDetails | Form/Report | 732 | None |
| Form_frmOrderList | Form/Report | 107 | None |
| Form_frmProductDetail | Form/Report | 636 | None |
| Form_frmProductList | Form/Report | 72 | None |
| Form_frmPurchaseOrderDetails | Form/Report | 631 | None |
| Form_frmPurchaseOrderList | Form/Report | 44 | None |
| Form_frmReports | Form/Report | 182 | None |
| Form_frmSelectVendorDialog | Form/Report | 77 | None |
| Form_frmWelcome | Form/Report | 42 | None |
| Form_sfrmAdmin_DeleteTestData | Form/Report | 85 | None |
| Form_sfrmAdmin_InternetOrders | Form/Report | 45 | None |
| Form_sfrmAdmin_ResetDates | Form/Report | 17 | None |
| Form_sfrmAdmin_Strings | Form/Report | 28 | None |
| Form_sfrmAdmin_SystemSettings | Form/Report | 28 | None |
| Form_sfrmCompanyDetail_Contacts | Form/Report | 66 | None |
| Form_sfrmCompanyDetail_CustomerOrders | Form/Report | 28 | None |
| Form_sfrmCompanyDetail_ShipperOrders | Form/Report | 28 | None |
| Form_sfrmCompanyDetail_VendorPurchaseOrders | Form/Report | 28 | None |
| Form_sfrmEmployee_Privileges | Form/Report | 66 | None |
| Form_sfrmOrderLineItems | Form/Report | 294 | None |
| Form_sfrmOrders_MostRecent_ByEmployee | Form/Report | 15 | None |
| Form_sfrmProductCategories | Form/Report | 158 | None |
| Form_sfrmProductDetail_Orders | Form/Report | 15 | None |
| Form_sfrmProductDetail_PurchaseOrders | Form/Report | 17 | None |
| Form_sfrmProductDetail_StockTake | Form/Report | 132 | None |
| Form_sfrmProductDetail_Vendors | Form/Report | 37 | None |
| Form_sfrmPurchaseOrderLineItems | Form/Report | 121 | None |
| modCompanies | Standard | 28 | None |
| modDAO | Standard | 88 | None |
| modDebug | Standard | 34 | None |
| modFiles | Standard | 46 | None |
| modForms | Standard | 100 | None |
| modGlobal | Standard | 472 | None |
| modInventory | Standard | 391 | None |
| modMath | Standard | 51 | None |
| modOrders | Standard | 227 | None |
| modPurchaseOrders | Standard | 190 | None |
| modReportParameters | Standard | 47 | None |
| modRibbonCallback | Standard | 454 | None |
| modSecurity | Standard | 21 | None |
| modStartup | Standard | 195 | None |
| modStrings | Standard | 221 | None |
| modTableDataMacros | Standard | 69 | None |
| modValidation | Standard | 171 | None |
| Report__Design | Form/Report | 41 | None |
| Report_rptEmployeeEmailList | Form/Report | 42 | None |
| Report_rptEmployeePhoneList | Form/Report | 42 | None |
| Report_rptInvoice | Form/Report | 41 | None |
| Report_rptLearn | Form/Report | 41 | None |
| Report_rptProductCatalog | Form/Report | 110 | None |
| Report_rptRelationshipsWindow | Form/Report | 41 | None |
| Report_rptSalesByEmployee | Form/Report | 79 | None |
| Report_rptSalesByProduct | Form/Report | 55 | None |
| Report_rptSalesByProductQuarterly | Form/Report | 55 | None |

---

## Macros
- Macro_ConditionalLogic
- Macro_ErrorHandling
- Macro_MessageBox
- Macro_MultipleActions
- Macro_OpenForm
- Macro_OpenFormFiltered
- Macro_OpenReport
- Macro_RunSQL
- Macro_SetProperties
- Macro_Submacros
- xAutoExec

---

## Relationships
| Relationship | From | To | Fields |
|-------------|------|-----|--------|
| New_New_CompaniesContacts | Contacts | Companies | CompanyID -> CompanyID |
| New_New_CompaniesOrders | Orders | Companies | CompanyID -> CustomerID |
| New_New_CompaniesOrders1 | Orders | Companies | CompanyID -> ShipperID |
| New_New_CompaniesProductVendors | ProductVendors | Companies | CompanyID -> VendorID |
| New_New_CompaniesPurchaseOrders | PurchaseOrders | Companies | CompanyID -> VendorID |
| New_New_CompanyTypesCompanies | Companies | CompanyTypes | CompanyTypeID -> CompanyTypeID |
| New_New_EmployeesEmployeePrivileges | EmployeePrivileges | Employees | EmployeeID -> EmployeeID |
| New_New_EmployeesEmployees | Employees | Employees | EmployeeID -> SupervisorID |
| New_New_EmployeesMRU | MRU | Employees | EmployeeID -> EmployeeID |
| New_New_EmployeesOrders | Orders | Employees | EmployeeID -> EmployeeID |
| New_New_EmployeesPurchaseOrders1 | PurchaseOrders | Employees | EmployeeID -> ApprovedByID |
| New_New_EmployeesPurchaseOrders2 | PurchaseOrders | Employees | EmployeeID -> SubmittedByID |
| New_New_OrderDetailsStatusOrderDetails | OrderDetails | OrderDetailStatus | OrderDetailStatusID -> OrderDetailStatusID |
| New_New_OrdersOrderDetails | OrderDetails | Orders | OrderID -> OrderID |
| New_New_OrdersStatusOrders | Orders | OrderStatus | OrderStatusID -> OrderStatusID |
| New_New_PrivilegesEmployeePrivileges | EmployeePrivileges | Privileges | PrivilegeID -> PrivilegeID |
| New_New_ProductCategories_NEWProducts | Products | ProductCategories | ProductCategoryID -> ProductCategoryID |
| New_New_ProductsOrderDetails | OrderDetails | Products | ProductID -> ProductID |
| New_New_ProductsProductVendors | ProductVendors | Products | ProductID -> ProductID |
| New_New_ProductsPurchaseOrderDetails | PurchaseOrderDetails | Products | ProductID -> ProductID |
| New_New_ProductsStockTake | StockTake | Products | ProductID -> ProductID |
| New_New_PurchaseOrdersPurchaseOrderDetails | PurchaseOrderDetails | PurchaseOrders | PurchaseOrderID -> PurchaseOrderID |
| New_New_PurchaseOrdersStatusPurchaseOrders | PurchaseOrders | PurchaseOrderStatus | StatusID -> StatusID |
| New_New_SalutationsEmployees | Employees | Titles | Title -> Title |
| New_New_StatesCompanies | Companies | States | StateAbbrev -> StateAbbrev |
| New_New_TaxStatusCompanies | Companies | TaxStatus | TaxStatusID -> StandardTaxStatusID |
| New_New_TaxStatusOrders | Orders | TaxStatus | TaxStatusID -> TaxStatusID |

---

## Findings Detail

### Warnings

- **form: frmCompanyList** -- Has 7 VBA event procedures requiring translation.
- **form: frmEmployeeList** -- Contains 1 subform(s). Subforms are supported but add complexity.
- **form: frmEmployeeList** -- Has 6 VBA event procedures requiring translation.
- **form: sfrmOrderLineItems** -- Has 6 VBA event procedures requiring translation.
- **form: frmPurchaseOrderDetails** -- Contains 1 subform(s). Subforms are supported but add complexity.
- **form: frmPurchaseOrderDetails** -- Has 15 VBA event procedures requiring translation.
- **form: frmOrderDetails** -- Contains 1 subform(s). Subforms are supported but add complexity.
- **form: frmOrderDetails** -- Has 16 VBA event procedures requiring translation.
- **form: frmProductDetail** -- Contains 4 subform(s). Subforms are supported but add complexity.
- **form: frmProductDetail** -- Has 17 VBA event procedures requiring translation.
- **form: _Design** -- Contains 4 subform(s). Subforms are supported but add complexity.
- **form: frmAdmin** -- Contains 1 subform(s). Subforms are supported but add complexity.
- **form: frmAdmin** -- Has 9 VBA event procedures requiring translation.
- **form: frmCompanyDetail** -- Contains 2 subform(s). Subforms are supported but add complexity.
- **form: frmCompanyDetail** -- Has 15 VBA event procedures requiring translation.
- **form: frmReports** -- Has 9 VBA event procedures requiring translation.

### Information

- **query: qryPurchaseOrderList** -- Uses Access-specific functions: Nz. *These are automatically converted during migration (IIf->CASE, Nz->COALESCE, etc.).*
- **query: qryrptEmployeePhoneList** -- Uses Access-specific functions: Left$?. *These are automatically converted during migration (IIf->CASE, Nz->COALESCE, etc.).*
- **query: qryrptSalesByEmployee** -- Uses Access-specific functions: Format$?. *These are automatically converted during migration (IIf->CASE, Nz->COALESCE, etc.).*
- **query: qryrptSalesByProduct_ByMonth** -- Uses Access-specific functions: Format$?. *These are automatically converted during migration (IIf->CASE, Nz->COALESCE, etc.).*
- **query: qryrptSalesByProduct_ByQuarter** -- Uses Access-specific functions: Format$?. *These are automatically converted during migration (IIf->CASE, Nz->COALESCE, etc.).*
- **module: modStrings** -- 221 lines of VBA code.
- **module: modGlobal** -- 472 lines of VBA code.
- **module: modRibbonCallback** -- 454 lines of VBA code.
- **module: modInventory** -- 391 lines of VBA code.
- **module: modOrders** -- 227 lines of VBA code.
- **module: Form_sfrmOrderLineItems** -- 294 lines of VBA code.
- **module: Form_frmPurchaseOrderDetails** -- 631 lines of VBA code.
- **module: Form_frmProductDetail** -- 636 lines of VBA code.
- **module: Form_frmCompanyList** -- 233 lines of VBA code.
- **module: Form_frmEmployeeList** -- 283 lines of VBA code.
- **module: Form_frmAdmin** -- 201 lines of VBA code.
- **module: Form_frmCompanyDetail** -- 713 lines of VBA code.
- **module: Form_frmOrderDetails** -- 732 lines of VBA code.

---

## Migration Readiness
This database has no blocking issues. It is ready for migration.

### Complexity Assessment

- Schema complexity: 28 tables, 27 relationships -- moderate
- Query complexity: 65 queries -- complex
- Form complexity: 40 forms, 32 with VBA events -- complex
- VBA complexity: 9047 total lines across 66 modules -- significant

---

*Generated by Three Horse Qualifying Analysis*
*Learn more: https://three.horse*

