# Acme Equipment Hire - Detailed Requirements

## Credit control

The system should hold a credit limit for each customer. When a customer's exposure exceeds the credit limit, a quote may be blocked or sent for approval.

Exposure is calculated as open receivables plus unbilled rental value plus new order value.

## Definitions

- **Reservation:** A time-bounded hold on availability that is not necessarily a confirmed contract.
- **Charge:** A priced component such as rent, delivery or cleaning.

## Open items

- Who approves a late-fee waiver has not been decided.
- Whether the billing method is chosen per customer or per agreement is not decided.
