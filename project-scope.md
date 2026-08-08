# Project Scope: Modular Multi-Strategy Quantitative Trading Platform

## 1. Project Overview & Objective
A local, personal quantitative trading platform built on the Interactive Brokers (IB) API. Engineered with a **NestJS** backend daemon and a **Next.js** control dashboard, backed by **MySQL** for data persistence. The platform is designed with a modular **Strategy Pattern** to support multiple concurrent trading strategies (Quantitative Grid, The Wheel Strategy, LEAPs accumulation, and Simple Buy/Sell) with mandatory containerization and rigorous test coverage.

---

## 2. Core Functional Requirements

### Multi-Strategy Engine (Plugin Architecture)
* Abstract strategy interface defining lifecycle hooks (`initialize`, `onTick`, `onBar`, `evaluate`, `terminate`).
* Concurrent execution of multiple distinct strategies across different symbols and asset classes.
* **Strategy Suite:**
    * **Quantitative Grid:** Automated bracket limit orders triggered at configured price increments (e.g., 100-point drops).
    * **The Wheel Strategy:** Systematic cash-secured put writing transitioning to covered call execution upon assignment.
    * **LEAPs / Long-Term Accumulation:** Timed or threshold-based multi-month equity and options positioning.
    * **Simple Buy / Sell:** Basic indicator or price-threshold execution logic.

### Broker & Data Management (Interactive Brokers API)
* Local socket integration with the IB Gateway / TWS application.
* Real-time market data streaming and historical candle ingestion.
* Order lifecycle management and execution tracking against paper/live accounts.

### Data Persistence (MySQL)
* Relational storage managed via Prisma ORM for order logs, trade audits, strategy states, and historical market data.

### Control & Telemetry Dashboard (Next.js)
* Real-time web UI to monitor account equity, toggle strategy states, adjust parameters on the fly, and view open positions.

---

## 3. System Architecture & Tech Stack

| Layer | Technology | Role |
| :--- | :--- | :--- |
| **Backend Core** | NestJS (TypeScript, RxJS) | Core event loop, IB socket connector, and multi-strategy coordinator. |
| **Data & ORM** | MySQL 8.0 + Prisma ORM | Relational state management and audit logging. |
| **Frontend UI** | Next.js (App Router, Tailwind) | Local monitoring and strategy control center. |
| **Testing Suite** | Jest & Supertest | Unit, integration, and mocking framework for strategy logic and API routes. |
| **Infrastructure** | Docker & Docker Compose | Containerized local runtime orchestrating the NestJS backend, Next.js UI, MySQL database, and IB Gateway. |

---

## 4. Mandatory Testing & Containerization Scope

### Testing Standards
* **Unit Testing:** Jest-based unit tests covering core strategy calculation logic (e.g., verifying grid level math, option assignment transitions, and risk thresholds).
* **Integration & Mocking:** Mocked IB socket streams and database repositories to test end-to-end execution flows without risking live API interactions.
* **Coverage Requirements:** Strict validation of order payload generation, error handling during broker disconnects, and state recovery after restarts.

### Dockerization Standards
* **Container Parity:** Complete `docker-compose.yml` defining services for MySQL, the NestJS backend, and the local headless IB Gateway.
* **Environment Isolation:** Containerized development workflow ensuring identical runtime behavior across host machines.