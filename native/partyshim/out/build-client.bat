@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cl /nologo /MT /O2 /W3 /EHsc /std:c++17 /D_CRT_SECURE_NO_WARNINGS /I"C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\partyshim\vendor" "C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\partyshim\test\party_client.cpp" /Fo"C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\partyshim\out\\" /Fe"C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\partyshim\out\party_client.exe" /link "C:\Users\One\Downloads\Compressed\Accela-main\Librarian\native\partyshim\out\PartyWin.lib"
exit /b %ERRORLEVEL%
