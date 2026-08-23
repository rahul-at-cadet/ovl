import { useEffect, useState } from 'react';
import { Paperclip, UploadCloud, File, X, Loader2, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { API_ORIGIN as API_BASE } from '@/lib/api-origin';

interface Attachment {
  id: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
}

interface AttachmentsSectionProps {
  reportId: string;
}

export function AttachmentsSection({ reportId }: AttachmentsSectionProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');

  const loadAttachments = async () => {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/reports/${reportId}/attachments`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load attachments');
      setAttachments(await res.json());
    } catch (err: any) {
      setError(err.message || 'Failed to load attachments');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAttachments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      setError('File must be less than 5MB');
      return;
    }

    setIsUploading(true);
    setError('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API_BASE}/reports/${reportId}/attachments`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || 'Upload failed');
      }

      await loadAttachments();
    } catch (err: any) {
      setError(err.message || 'An error occurred during upload');
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  const removeAttachment = async (id: string) => {
    setError('');
    try {
      const res = await fetch(`${API_BASE}/reports/${reportId}/attachments/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || 'Delete failed');
      }
      setAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch (err: any) {
      setError(err.message || 'Failed to delete attachment');
    }
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
          Upload photos or PDFs to attach to this report (Max 5MB)
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-4">
        {error && (
          <div className="text-red-400 text-sm p-3 bg-red-400/10 border border-red-400/20 rounded-md">
            {error}
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading attachments…</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {attachments.map((file) => (
              <div key={file.id} className="flex items-center justify-between p-3 bg-background border border-border rounded-md">
                <div className="flex items-center space-x-3 overflow-hidden">
                  <div className="p-2 bg-primary/10 text-primary rounded-md shrink-0">
                    <File className="w-4 h-4" />
                  </div>
                  <div className="overflow-hidden">
                    <p className="text-sm font-medium text-foreground truncate">{file.filename}</p>
                    <p className="text-xs text-muted-foreground">{formatSize(file.sizeBytes)}</p>
                  </div>
                </div>
                <div className="flex items-center shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => window.open(`${API_BASE}/reports/${reportId}/attachments/${file.id}`, '_blank')}
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-red-400" onClick={() => removeAttachment(file.id)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

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
          <p className="text-xs text-muted-foreground mt-1">JPEG, PNG, PDF up to 5MB</p>
        </div>
      </CardContent>
    </Card>
  );
}
