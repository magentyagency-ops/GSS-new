"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

export function DocxPreviewViewer({ fileUrl }: { fileUrl: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let isMounted = true;
    
    async function loadDocx() {
      try {
        setLoading(true);
        setError("");
        
        // Dynamically import docx-preview only on the client side
        const docx = await import("docx-preview");
        
        const response = await fetch(fileUrl);
        if (!response.ok) throw new Error("Failed to fetch document");
        
        const blob = await response.blob();
        
        if (containerRef.current && isMounted) {
          await docx.renderAsync(blob, containerRef.current, undefined, {
            className: "docx-preview-rendered",
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: false,
            ignoreFonts: false,
            breakPages: true,
            useBase64URL: true,
          });
        }
      } catch (err: any) {
        if (isMounted) setError(err.message || "An error occurred");
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadDocx();

    return () => {
      isMounted = false;
    };
  }, [fileUrl]);

  return (
    <div className="relative w-full rounded-md border border-slate-200 bg-slate-100 mt-6 shadow-inner">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 z-10 rounded-md">
          <div className="flex flex-col items-center text-slate-500">
            <Loader2 className="h-8 w-8 animate-spin mb-4" />
            <p>Rendu du document Word en cours...</p>
          </div>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-50 text-red-600 p-6 z-10 text-center rounded-md border border-red-200">
          <p><strong>Erreur de prévisualisation :</strong> {error}</p>
        </div>
      )}
      
      <div 
        ref={containerRef} 
        className="w-full h-[700px] overflow-auto px-4 py-8"
        style={{
          /* Style tweaks for docx-preview to make it look like a page */
          display: "flex",
          flexDirection: "column",
          alignItems: "center"
        }}
      />
    </div>
  );
}
