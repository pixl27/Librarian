@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cl /nologo /LD /MT /O2 /W3 /EHsc /std:c++20 /D_CRT_SECURE_NO_WARNINGS /I"C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\rebebypass" "C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\rebebypass\rebebypass.cpp" /Fo"C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\rebebypass\out\\" /Fe"C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\rebebypass\out\rebebypass.dll"
exit /b %ERRORLEVEL%
