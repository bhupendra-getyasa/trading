trading
│
├── .env
├── docker-compose.yml
├── package.json
│
├── packages
│   └── shared/
│       ├── .env
│       ├── index.js
│       ├── Dockerfile
│       ├── package.json
│       └──src/
│           ├── db/
│           │   └── postgres.js
│           │
│           ├── redis/
│           │   └── connection.js
│           │
│           └── bullmq/
│               ├── queues.js
│               └── events.js
│   
│
└── apps/
    ├── ingestion-service/
    │    ├── .env
    │    ├── Dockerfile
    │    ├── package.json
    │    └── src/
    │       ├── scraper.js
    │       ├── publisher.js
    │       ├── worker.js
    │       └── index.js
    │
    │
    └── websocket-service/
        ├── .env
        ├── index.js
        ├── package.json
        └── src/
            ├── index.js
            └── worker.js

