# Task Manager API

A small REST API for managing personal tasks, built as the capstone for FSD-101.

## Features

- Create, list, update and delete tasks
- Tasks have a title, optional description, due date and status (`todo`, `doing`, `done`)
- Input validation with helpful error messages
- SQLite persistence with a simple migration script
- Automated tests with the Node test runner

## Setup

```bash
npm install
npm run migrate
npm start
```

The server listens on `http://localhost:3000`.

## API

| Method | Path          | Description        |
|--------|---------------|--------------------|
| GET    | /tasks        | List tasks         |
| POST   | /tasks        | Create a task      |
| GET    | /tasks/:id    | Get one task       |
| PATCH  | /tasks/:id    | Update a task      |
| DELETE | /tasks/:id    | Delete a task      |

## Architecture

```
src/index.js        -> HTTP server, routing
src/routes/tasks.js -> request handling and validation
src/services/       -> business rules (status transitions, due-date checks)
src/db/             -> schema and query helpers
tests/              -> API tests
```

I kept routing, business rules and persistence in separate modules so each can be tested on its own.

## Decisions

- SQLite was chosen over Postgres to keep local setup to zero steps.
- No framework: the project is small enough that the built-in `http` module keeps dependencies minimal and shows how routing works underneath.

## Tests

```bash
npm test
```
