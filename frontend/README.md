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
- **Storage**: Cloudinary (for secure, temporary PDF & image storage)

## Getting Started

### Prerequisites

You will need the following environment variables. Create a `.env.local` file in the root directory:

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

This platform is fully optimized for **Vercel** deployment.

1. Connect your GitHub repository to Vercel.
2. In the Vercel dashboard, navigate to **Settings > Environment Variables**.
3. Add all the environment variables from your `.env.local` file.
4. Trigger the deployment.

Vercel will automatically run `npm run build` and provision the serverless Edge Functions for the backend queue and API routes.

## License

This project is proprietary. All rights reserved.
