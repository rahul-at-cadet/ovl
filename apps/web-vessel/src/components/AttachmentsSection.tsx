import { useState } from 'react';
import { Paperclip, UploadCloud, File, X, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Attachment {
  fileId: string;
  filename: string;
  size: number;
  url: string;
}

interface AttachmentsSectionProps {
  reportId: string;
}

export function AttachmentsSection({ reportId }: AttachmentsSectionProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      setError('File must be less than 10MB');
      return;
    }

    setIsUploading(true);
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`http://localhost:3003/reports/${reportId}/attachments`, {
        method: 'POST',
        body: formData,
        // credentials: 'omit' // Depending on cors
      });

      if (!res.ok) {
        throw new Error('Upload failed');
      }

      const data = await res.json();
      setAttachments([...attachments, data]);
    } catch (err: any) {
      setError(err.message || 'An error occurred during upload');
    } finally {
      setIsUploading(false);
      // reset file input
      e.target.value = '';
    }
  };

  const removeAttachment = (fileId: string) => {
    setAttachments(attachments.filter(a => a.fileId !== fileId));
    // In a real implementation, we would also call a DELETE endpoint here.
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <Card className="bg-card/50 border-border">
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-lg font-medium text-foreground flex items-center">
          <Paperclip className="w-5 h-5 mr-2 text-muted-foreground" />
          Attachments
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Upload photos, documents, or logs to attach to this report (Max 10MB)
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        {error && (
          <div className="text-red-400 text-sm p-3 bg-red-400/10 border border-red-400/20 rounded-md">
            {error}
          </div>
        )}
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {attachments.map((file) => (
            <div key={file.fileId} className="flex items-center justify-between p-3 bg-background border border-border rounded-md">
              <div className="flex items-center space-x-3 overflow-hidden">
                <div className="p-2 bg-primary/10 text-primary rounded-md shrink-0">
                  <File className="w-4 h-4" />
                </div>
                <div className="overflow-hidden">
                  <p className="text-sm font-medium text-foreground truncate">{file.filename}</p>
                  <p className="text-xs text-muted-foreground">{formatSize(file.size)}</p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-red-400 shrink-0" onClick={() => removeAttachment(file.fileId)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </div>

        <div className="border-2 border-dashed border-border rounded-xl p-8 text-center flex flex-col items-center justify-center bg-background/30 transition-colors hover:bg-card/50 hover:border-border relative">
          <input 
            type="file" 
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" 
            onChange={handleFileChange}
            disabled={isUploading}
          />
          {isUploading ? (
            <Loader2 className="w-8 h-8 text-primary animate-spin mb-3" />
          ) : (
            <UploadCloud className="w-8 h-8 text-muted-foreground mb-3" />
          )}
          <p className="text-sm font-medium text-foreground">
            {isUploading ? 'Uploading...' : 'Click or drag file to upload'}
          </p>
          <p className="text-xs text-muted-foreground mt-1">JPEG, PNG, PDF, CSV up to 10MB</p>
        </div>
      </CardContent>
    </Card>
  );
}
