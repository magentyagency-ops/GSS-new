import express from 'express';
import cors from 'cors';
import routes from './api/routes';

const app = express();
const port = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());

// Prefix all routes with /api
app.use('/api', routes);

// Fallback to direct routes prefix for compatibility if needed (FastAPI router had prefix /api)
// So /api/health was under router with prefix /api, meaning the full path is /api/health.
// App.use('/api', routes) maps routes like router.get('/health') to /api/health. Perfect!

app.listen(port, () => {
  console.log(`GSS-AO Backend server listening at http://localhost:${port}`);
});

export default app;
