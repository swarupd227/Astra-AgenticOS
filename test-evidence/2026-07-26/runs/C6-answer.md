Let me look up the organisation's glossary and survey the codebase at the same time.Good — I have the glossary definition and can see the codebase is a Java project. Let me now explore its structure and search for charge/fee/visit-related code simultaneously.No existing charge concept in the codebase. Let me now read all the key Visit-related source files to understand the full data model and flow.Now I have a thorough picture of the entire codebase. Let me compile the full answer.

---

## What "Statutory Levy" Means in Your Organisation

Per your organisation's **Payments Domain Glossary (`GLD-GLO-001@1`)**:

> **Levy** — Any statutory charge applied to a transaction by an authority. In code this is modelled as a **`Charge` with `ChargeType.Statutory`** — *never* as a fee.

Two things immediately follow from that definition:

1. **Terminology precision**: It must be called a *levy* (not a fee, surcharge, or tax) in all requirements, code, and UI. Using the wrong term is explicitly called out in the glossary as a risk.
2. **Modelling prescription**: The glossary dictates the pattern — a `Charge` domain object with an enum discriminator `ChargeType.Statutory`. This pattern does **not yet exist** in the codebase (confirmed by `search_code` — zero matches for `charge`, `fee`, `levy`, `amount`, `price`, `cost`).

---

## Where It Fits in This Codebase

The codebase is a **Spring Boot 4.1 / Java 17 / Maven** application (Spring PetClinic). Here is the complete visit-booking flow with file evidence, and where a statutory levy slots in at each layer:

### Current Visit Flow (Observed)

```
HTTP POST /owners/{ownerId}/pets/{petId}/visits/new
    │
    ▼
VisitController.processNewVisitForm()          [VisitController.java:98]
    │  validates date is in the future         [VisitController.java:100–101]
    │  validates description is not blank      [Visit.java:42–43]
    │
    ▼
Owner.addVisit(petId, visit)                   [Owner.java:164]
    │  asserts petId and visit non-null        [Owner.java:166–167]
    │  resolves the Pet by id                  [Owner.java:169–171]
    │  delegates to Pet.addVisit(visit)        [Owner.java:173]
    │
    ▼
OwnerRepository.save(owner)                    [VisitController.java:109]
    │  cascades ALL → saves Visit              [Pet.java:56]
    │
    ▼
visits table  (schema via db/${database}/schema.sql, property:
               spring.sql.init.schema-locations [application.properties:3])
```

### Where the Statutory Levy Must Be Inserted

The levy must be **calculated and attached at booking time** — i.e., inside `VisitController.processNewVisitForm()` after validation passes but before `OwnerRepository.save()` is called. Here is the full layered change map:

| Layer | What needs to change | Evidence anchor |
|---|---|---|
| **Domain model — new** | Create `Charge` entity with `ChargeType` enum (`STATUTORY`, etc.) as prescribed by `GLD-GLO-001@1` | No existing `Charge` class — `search_code` confirms zero matches |
| **Domain model — Visit** | Add a `List<Charge>` (or a single `Charge`) OneToMany/OneToOne to `Visit`; persist via `CascadeType.ALL` matching the pattern used for Pet→Visit | `Visit.java:36`, `Pet.java:56` |
| **Service layer — new** | Introduce a `LevyCalculationService` (a Spring `@Service`) that accepts a `Visit` (or pet type / visit date) and returns the computed `Charge` with `ChargeType.STATUTORY` | Currently no service layer exists; `OwnerRepository` is called directly from the controller (`VisitController.java:109`) |
| **Controller** | In `processNewVisitForm`, after validation succeeds, call `levyCalculationService.calculateLevy(visit)` and attach the resulting `Charge` to the `Visit` before saving | `VisitController.java:108–109` is the insertion point |
| **Database schema** | Add a `charges` table (columns: `id`, `visit_id` FK, `charge_type`, `amount`, `currency`, `effective_date`); update `db/h2/schema.sql` and `db/mysql/schema.sql` | Schema location: `application.properties:3` |
| **Thymeleaf view** | Display the levy amount on the visit confirmation/owner detail page | Currently redirects to `/owners/{ownerId}` (`VisitController.java:111`) |
| **Tests** | Extend `VisitControllerTests` (currently 4 tests at `VisitControllerTests.java`) and `ClinicServiceTests` to assert levy is calculated and persisted | `VisitControllerTests.java:47`, `ClinicServiceTests.java:219` |

### Key Constraints Already in the Code

| Constraint | Source |
|---|---|
| A `Visit` must be dated **strictly in the future** (tomorrow or later); the levy calculation must respect the same date | `VisitController.java:100`, `Visit.java:48–49` |
| `description` is `@NotBlank` — levy must not change that validation | `Visit.java:42–43` |
| `id` and `*.id` fields are **disallowed in form binding** by `@InitBinder` — `Charge.id` must not be form-bound | `VisitController.java:53` |
| Persistence cascades from `Owner → Pet → Visit` via `CascadeType.ALL` — a `Visit → Charge` cascade must align | `Pet.java:56`, `Owner.java:64` |
| The `database` property is externalised (`h2` default, MySQL also supported) — schema changes must be provided for both dialects | `application.properties:2–3` |

---

## Open Questions You Must Resolve Before Implementing

1. **Levy rate & basis**: What is the rate (flat amount, percentage of a base fee, or per-pet-type)? The codebase has no existing monetary fields whatsoever — the rate source (config property, DB lookup table, external API) is entirely undefined.
2. **Currency**: No currency concept exists anywhere in the codebase. Must `Charge` carry a currency code (ISO 4217)? Is the clinic single-currency?
3. **Rounding rule**: If the levy is percentage-based, what rounding convention applies (half-up, banker's rounding)?
4. **Retroactivity**: Does the levy apply only to new bookings, or must it be back-applied to existing `visits` rows?
5. **Levy revision**: If the statutory rate changes mid-year, is the levy locked at booking date or recalculated?
6. **Display & reporting**: Must the levy appear on screen immediately after booking? Is a financial report or audit extract required?
7. **Void/cancellation**: The codebase has no visit cancellation flow. If a visit is deleted, is the levy reversed?

---

Would you like me to now produce a full **BRD** for the statutory levy feature, or first resolve some of these open questions with your team?
