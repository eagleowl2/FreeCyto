dev-backend:
\t./backend/run.sh

dev-frontend:
\tcd frontend && npm run dev

dev: dev-backend dev-frontend

