"""Bounded local document extraction; never executes PDF JavaScript or uploads content."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

MAX_INPUT=25*1024*1024
MAX_STREAM=4*1024*1024
MAX_TEXT=512*1024


def status():
    try:
        import pypdf
        version=pypdf.__version__
    except ImportError:
        version=None
    engine='tesseract' if shutil.which('tesseract') else 'apple-vision' if sys.platform=='darwin' and shutil.which('swiftc') else None
    return {'pdf':bool(version),'pypdf':version,'python':sys.executable,'ocr':bool(engine and shutil.which('pdftoppm')),'ocrEngine':engine,'rasterizer':bool(shutil.which('pdftoppm')),'setup':'Install pypdf>=6.10,<8 in the Python environment used by the IDE (python3 -m pip install "pypdf>=6.10,<8"). Local OCR requires pdftoppm plus Tesseract with English data, or Apple Vision/Swift on macOS. No packages or models are installed automatically.'}


def data(file):
    descriptor=os.open(file,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
    with os.fdopen(descriptor,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>MAX_INPUT:raise ValueError('Choose a regular document up to 25 MB')
        value=stream.read(MAX_INPUT+1)
        if len(value)>MAX_INPUT:raise ValueError('Document exceeds 25 MB')
        return value


def run(command,timeout,file_limit=20*1024*1024):
    def limits():
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE,(file_limit,file_limit))
    with tempfile.TemporaryFile() as output,tempfile.TemporaryFile() as errors:
        result=subprocess.run(command,stdout=output,stderr=errors,timeout=timeout,env={**os.environ,'OMP_THREAD_LIMIT':'1'},preexec_fn=limits if os.name=='posix' else None)
        output_size,errors_size=output.tell(),errors.tell()
        errors.seek(max(0,errors_size-1500))
        if result.returncode:raise ValueError('Local document tool failed: '+errors.read(1500).decode(errors='replace'))
        if output_size>MAX_TEXT or errors_size>MAX_TEXT:raise ValueError('Local tool output exceeds 512 KB')
        output.seek(0)
        return output.read(MAX_TEXT).decode('utf-8')


def extract(request):
    file=Path(request['file'])
    value=data(file)
    result={'sourceHash':hashlib.sha256(value).hexdigest(),'pages':[],'warnings':[]}
    first,pages,ocr=request.get('firstPage',1),request.get('pages',20),request.get('ocr',False)
    if type(first)is not int or not 1<=first<=200 or type(pages)is not int or not 1<=pages<=20 or type(ocr)is not bool or (ocr and pages>3):raise ValueError('Choose up to 20 pages, or at most three pages with OCR')
    if file.suffix.lower() in ('.md','.txt'):
        if first!=1:raise ValueError('Text documents have one page')
        if len(value)>MAX_TEXT:raise ValueError('Choose UTF-8 text below 512 KB')
        text=value.decode('utf-8')
        if '\0' in text or len(value)>MAX_TEXT:raise ValueError('Choose UTF-8 text below 512 KB without binary content')
        result.update(totalPages=1,pages=[{'page':1,'text':text,'method':'utf8-text'}])
        return result
    if file.suffix.lower()!='.pdf':raise ValueError('Choose PDF, Markdown or UTF-8 text')
    try:
        import pypdf
        import pypdf.filters as filters
    except ImportError as error:raise ValueError(status()['setup']) from error
    required=('ZLIB_MAX_OUTPUT_LENGTH','LZW_MAX_OUTPUT_LENGTH','MAX_DECLARED_STREAM_LENGTH','MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH','RUN_LENGTH_MAX_OUTPUT_LENGTH','JBIG2_MAX_OUTPUT_LENGTH')
    if any(not hasattr(filters,name) for name in required):raise ValueError('Update pypdf to >=6.10,<8 for bounded PDF decompression')
    for name in required:setattr(filters,name,MAX_STREAM)
    decode=filters.decode_stream_data
    decoded_bytes=0
    def bounded_decode(*args,**kwargs):
        nonlocal decoded_bytes
        result=decode(*args,**kwargs)
        decoded_bytes+=len(result)
        if decoded_bytes>16*1024*1024:raise ValueError('PDF decoded content exceeds 16 MB; split or simplify it')
        return result
    filters.decode_stream_data=bounded_decode
    reader=pypdf.PdfReader(io.BytesIO(value),strict=True)
    if reader.is_encrypted:raise ValueError('Encrypted PDFs are unsupported; export an unencrypted copy explicitly')
    total=len(reader.pages)
    if total>200:raise ValueError('PDF exceeds 200 pages; split it into smaller documents')
    if first>total:raise ValueError('First page is past the end of the document')
    result['totalPages']=total
    selected=range(first,min(total+1,first+pages))
    readiness=status()
    if ocr and not readiness['ocr']:raise ValueError('Local OCR is unavailable. '+readiness['setup'])
    with tempfile.TemporaryDirectory(prefix='aiide-document-') as temporary:
        temporary=Path(temporary)
        snapshot=temporary/'source.pdf'
        if ocr:snapshot.write_bytes(value)
        binary=temporary/'vision-ocr'
        if ocr and readiness['ocrEngine']=='apple-vision':run([shutil.which('swiftc'),str(Path(__file__).with_name('ocr.swift')),'-o',str(binary)],30,128*1024*1024)
        count=0
        for number in selected:
            if ocr:
                prefix=temporary/('page-'+str(number))
                run([shutil.which('pdftoppm'),'-f',str(number),'-l',str(number),'-singlefile','-scale-to','2000','-png',str(snapshot),str(prefix)],20)
                image=prefix.with_suffix('.png')
                if image.stat().st_size>20*1024*1024:raise ValueError('Rendered page exceeds 20 MB')
                text=run([shutil.which('tesseract'),str(image),'stdout','-l','eng'],20) if readiness['ocrEngine']=='tesseract' else json.loads(run([str(binary),str(image)],20))['text']
                method=readiness['ocrEngine']+'-ocr'
            else:
                page=reader.pages[number-1]
                contents=page.get_contents()
                if contents is not None and len(contents.get_data())>MAX_STREAM:raise ValueError('Page content exceeds 4 MB; split or simplify the PDF')
                text=page.extract_text() or ''
                method='pdf-text'
            size=len(text.encode('utf-8'))
            count+=size
            if size>65536 or count>MAX_TEXT:raise ValueError('Extracted text exceeds preview limits; select fewer or simpler pages')
            if not text.strip():result['warnings'].append(f'Page {number} contains no extractable text. Try explicitly enabling local OCR for scanned pages.')
            result['pages'].append({'page':number,'text':text,'method':method})
    return result


if __name__=='__main__':
    try:
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_CPU,(40,40))
            if sys.platform.startswith('linux'):resource.setrlimit(resource.RLIMIT_AS,(1024*1024*1024,1024*1024*1024))
        except (ImportError,ValueError,OSError):pass
        request=json.load(sys.stdin)
        print(json.dumps({'ok':True,'result':status() if request['action']=='status' else extract(request)}))
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error)}))
