Good — both mandatory standards are loaded, and I've identified the app as Spring Boot (PetClinic). Now let me inventory all config files and scan for secrets and insecure settings.Now I have a complete picture. Let me compile and save the audit report.Here is the complete audit, saved as `config-audit.md`. Here's a structured summary of everything found:

---

## Config & Secrets Audit — Spring PetClinic
*Standards applied: GLD-STD-010@1 (OWASP Secrets Management), GLD-STD-009@1 (OWASP Logging)*

---

### 🔴 Critical — 4 findings (rotate credentials immediately)

| ID | Finding | Location |
|----|---------|----------|
| **C-01** | `spring.datasource.password` defaults to the literal string `petclinic` if `$MYSQL_PASS` is unset — the fallback **is** the secret | `application-mysql.properties:5` |
| **C-02** | Same pattern for PostgreSQL — `${POSTGRES_PASS:petclinic}` | `application-postgres.properties:5` |
| **C-03** | Plaintext `MYSQL_PASSWORD=petclinic` and `POSTGRES_PASSWORD=petclinic` committed directly in the Compose file | `docker-compose.yml:10, 19` |
| **C-04** | Kubernetes `Secret` manifest stores credentials as `stringData: password: "pass"` / `username: "user"` — trivially guessable **and** in source | `k8s/db.yml:13–14` |

> Per **GLD-STD-010@1 §2.7.3**: rotation is the non-negotiable first step. These credentials must be considered **already compromised**. Deleting the values from files without rotating them is not remediation. Git history purging is a separate, destructive, human-gated operation.

---

### 🟠 High — 2 findings

| ID | Finding | Location |
|----|---------|----------|
| **I-01** | `management.endpoints.web.exposure.include=*` exposes **all** Actuator endpoints (including `/actuator/env`, `/actuator/heapdump`) with no authentication. The file itself comments "Don't do this in production" — but there is no production-profile override. | `application.properties:21` |
| **I-02** | `MYSQL_ALLOW_EMPTY_PASSWORD=true` with a blank `MYSQL_ROOT_PASSWORD=` — MySQL root has no password. | `docker-compose.yml:7–8` |

---

### 🟡 Medium — 2 findings

| ID | Finding | Location |
|----|---------|----------|
| **I-03** | `spring.sql.init.mode=always` re-runs DDL/DML scripts on every startup — dangerous if a prod DB URL is ever injected | `application-mysql.properties:7`, `application-postgres.properties:7` |
| **E-01** | DB URLs default to `localhost` — no externalised, profile-specific host strategy for non-local deployments | `application-mysql.properties:3`, `application-postgres.properties:3` |

---

### 🔵 Low / Informational — 2 findings

| ID | Finding |
|----|---------|
| **E-02** | `Service.type: NodePort` in K8s exposes the app on a random host port on every cluster node — unsuitable for production (`k8s/petclinic.yml:7`) |
| **L-01** | No security event logging configured anywhere (no auth-failure, access-control, or admin-action logging) — required by **GLD-STD-009@1** |

---

### Remediation Plan (prioritised)

1. **Immediate** — Rotate all four sets of credentials above. Remove literal password defaults from `.properties` files (use `${VAR}` with no fallback so the app fails fast). Delete the `stringData` block from `k8s/db.yml`.
2. **Sprint** — Move secrets to a vault (Sealed Secrets / External Secrets Operator for K8s; AWS Secrets Manager / Azure Key Vault / HashiCorp Vault for the rest). The K8s `ServiceBinding` volume-mount pattern in `petclinic.yml` is already the right approach — wire it to a real secret store.
3. **Sprint** — Lock down Actuator: create `application-prod.properties` restricting exposure to `health` only and add Spring Security to gate sensitive endpoints.
4. **Next sprint** — Set `spring.sql.init.mode=never` in prod; adopt Flyway/Liquibase (already in the POM). Externalise DB hostnames. Replace `NodePort` with Ingress.
5. **Next sprint** — Implement structured security event logging (auth failures, access-control failures, admin actions) per **GLD-STD-009@1**. Ensure passwords and tokens are never written to logs.

> **One critical gap also observed:** `application-prod.properties` does not exist. Every insecure default in `application.properties` (wildcard Actuator exposure) applies to production today because there is no profile to override it.
