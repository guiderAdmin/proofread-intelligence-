# Proofreader Agent

An advanced, AI-powered document proofreading platform built with Next.js, TailwindCSS, and Google Gemini AI. It instantly analyzes educational PDFs, textbook content, and professional documents to detect grammar, spelling, pedagogy, styling, and formatting anomalies, and overlays intelligent bounding boxes directly onto an interactive PDF canvas.

## Features

- **Automated AI Analysis**: Utilizes Google Gemini to scan documents for formatting, styling, factual, and spelling/grammar issues.
- **Interactive PDF Canvas**: Precision bounding-box overlay showing exactly where each AI-identified issue occurs on the original document.
- **Dynamic Diagnostics**: Generates a visually stunning "Curriculum Intelligence Report" detailing syntax health, fact accuracy, and structural alignment.
- **Real-Time Collaboration**: Mark issues as resolved, ignored, or leave manual annotations directly on the canvas.
- **Scalable Architecture**: Powered by a MongoDB queue system optimized for streaming large multi-page PDF documents.

## Technology Stack

- **Framework**: Next.js 14 (App Router)
- **Styling**: Tailwind CSS
- **Database**: MongoDB (Mongoose)
- **AI Processing**: Google Gemini API
- **PDF Rendering**: React-PDF / pdf.js
- **Storage**: Cloudinary (saved source PDFs and rendered page images)

## Getting Started

### Prerequisites

Run commands from `frontend/` and create `.env.local` there, using `.env.example` as the starting point:

```env
# Database
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/<dbname>

# AI API Keys
GEMINI_API_KEY=your_gemini_api_key

# Cloud Storage
CLOUDINARY_URL=cloudinary://<key>:<secret>@<cloud_name>
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
CLOUDINARY_CLOUD_NAME=your_cloudinary_cloud_name

# App Authentication (Basic Auth for early access)
PROOFDESK_BASIC_PASSWORD=your_secure_password
PROOFDESK_BASIC_USER=your_user_name
```

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Deployment

Run `npm run build` and `npm start` for production. Each browser worker request now awaits one durable page job before returning. On Vercel, the open browser session drives worker requests; saved progress can be resumed after closing it. No cron configuration or scheduler endpoint is provided. The optional `npm run worker` is for persistent Node hosts only. Vercel worker routes set `maxDuration=300`; enable Fluid compute and check the host duration setting. Status polling does not start model work. See [deployment and reliability verification](docs/RELIABILITY-AUDIT.md).

This checkout uses `next start` for production. Keep the build directory and `public/` assets available on the deployed host.

Scanned documents use a local Tesseract executable when available, with the existing `tesseract.js` backend as the fallback. See [architecture and OCR configuration](docs/ARCHITECTURE.md) for storage, worker, coordinate, and deployment details. Run `npm test` for the isolated regression suite.

## License

This project is proprietary. All rights reserved.
